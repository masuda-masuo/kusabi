// free-worker-yaml.mjs — strict YAML frontmatter parsing and canonical
// permission validation for the opt-in OpenCode free worker profile
// (Agenda2001 / PR755).
//
// This module replaces the former hand-written line/regex parser.  Every
// security-relevant decision is made on the AST produced by the vendored,
// maintained `yaml` parser (YAML 1.2, see ../vendor/PROVENANCE.md).  There is
// exactly ONE semantic validator here; the fail-closed transform
// (`transformAgentForOptIn`) and the installed-content classifier
// (`classifyInstalledAgentContent`) both consume it, so their notion of
// "supported policy" can never diverge.
//
// Fail-closed rules enforced on the parsed document:
//   * exactly one YAML document, and its root must be a mapping;
//   * no duplicate mapping keys anywhere (quoted spelling of the same key is
//     the same key), detected on the AST — never "last wins";
//   * no YAML aliases (uncontrolled alias expansion is refused) and no `<<`
//     merge keys (they are never resolved);
//   * no non-core/custom tags, directives other than YAML 1.2, or parse
//     errors/warnings of any kind;
//   * `permission:` must be an ordered mapping whose FIRST rule is
//     `"*": deny` and which contains only the constrained rules
//     (`read: allow`, `bash: deny`, `StructuredOutput: allow` for review),
//     vetted anchored `sunaba_*`/`kaiba_*`/`shiori_*` tool grants, the
//     `shiori*` family glob, and the nested `skill:` map of `kusabi-*`
//     grants.  Anything else (host builtin, broad glob, extra wildcard,
//     conflicting scalar) is refused.
//
// A parse failure is NEVER downgraded to "no permission block" — the caller
// sees an explicit error and the classifier reports "unknown".

import {
  parseAllDocuments,
  isAlias,
  isMap,
  isScalar,
  isSeq,
} from "../vendor/yaml-esm.mjs";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

// Strict, side-effect-free parse options.  `uniqueKeys` makes the parser flag
// duplicate mapping keys; `merge: false` keeps `<<` as an ordinary key so it is
// refused rather than resolved; `strict` rejects tabs-as-indentation and other
// syntax hazards.  No custom tags/schema are registered, so any non-core tag
// surfaces as a `TAG_RESOLVE_FAILED` warning that we treat as fatal.
const PARSE_OPTIONS = Object.freeze({
  uniqueKeys: true,
  merge: false,
  strict: true,
});

export class FrontmatterError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/** Extract the `---`-framed frontmatter yarn.  Framing only; no YAML is parsed here. */
export function extractFrontmatter(content) {
  const text = String(content);
  const m = text.match(FRONTMATTER_RE);
  if (!m) return null;
  return { yaml: m[1], rest: text.slice(m[0].length) };
}

export const OPT_IN_CONSTRAINED_RULES = Object.freeze({
  read: "allow",
  bash: "deny",
  StructuredOutput: "allow",
});

// Legacy accepted values for installed agents (deprecated, tolerated during migration)
export const OPT_IN_LEGACY_CONSTRAINED_RULES = Object.freeze({
  read: "ask",
});

// Anchored, unambiguous vetted tool-namespace families for this opt-in
// profile.  These name specific MCP tools; the only wildcard grant tolerated
// is the shiori family glob the review template already uses.
const VETTED_TOOL_KEY_RES = [
  /^sunaba_[a-z0-9_]+$/,
  /^kaiba_[a-z0-9_]+$/,
  /^shiori_[a-z0-9_]+$/,
];
const VETTED_FAMILY_GLOBS = new Set(["shiori*"]);
const VETTED_SKILL_CHILD_RE = /^kusabi-[A-Za-z0-9_.-]+$/;

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isVettedToolKey(key) {
  return VETTED_FAMILY_GLOBS.has(key) || VETTED_TOOL_KEY_RES.some((re) => re.test(key));
}

// Canonical identity of a mapping key.  Prefixing the JS type keeps a numeric
// key and its string spelling distinct (no lossy coercion), while quoting of
// the same string key collapses to one identity (quoted-equivalent duplicate).
function keyIdentity(keyNode) {
  return `${typeof keyNode.value}:${String(keyNode.value)}`;
}

function lineOf(yamlText, node) {
  const pos =
    node?.range?.[0] ??
    node?.key?.range?.[0] ??
    node?.value?.range?.[0];
  if (pos == null) return null;
  return yamlText.slice(0, pos).split("\n").length;
}

function atPosition(yamlText, node) {
  const line = lineOf(yamlText, node);
  return line == null ? "" : ` (frontmatter line ${line})`;
}

function parseStrictDocument(yamlText) {
  let docs;
  try {
    docs = parseAllDocuments(yamlText, PARSE_OPTIONS);
  } catch (err) {
    throw new FrontmatterError(`invalid YAML frontmatter: ${err.message}`);
  }
  if (docs.length !== 1) {
    throw new FrontmatterError("agent frontmatter must contain exactly one YAML document");
  }
  const doc = docs[0];
  // Duplicate keys are surfaced precisely by auditSecurity on the AST, so only
  // other parse errors and every warning are fatal here.
  const hardErrors = doc.errors.filter((e) => e.code !== "DUPLICATE_KEY");
  const problems = [...hardErrors, ...doc.warnings];
  if (problems.length > 0) {
    throw new FrontmatterError(
      `invalid or unsupported YAML frontmatter: ${problems.map((p) => p.message).join("; ")}`
    );
  }
  const yamlDirective = doc.directives && doc.directives.yaml;
  if (yamlDirective && yamlDirective.version && yamlDirective.version !== "1.2") {
    throw new FrontmatterError(
      `unsupported YAML directive: only YAML 1.2 is supported (found ${yamlDirective.version})`
    );
  }
  return doc;
}

/**
 * Fail closed on constructs that make the permission policy ambiguous or
 * dangerous: aliases, merge keys, non-scalar keys and duplicate keys.  `kind`
 * selects the error noun ("top" document map vs the `permission` policy map).
 */
function auditSecurity(node, kind, yamlText) {
  if (isAlias(node)) {
    throw new FrontmatterError(
      "YAML aliases are not supported in agent frontmatter (uncontrolled alias expansion is refused)"
    );
  }
  if (isMap(node)) {
    const seen = new Set();
    for (const pair of node.items) {
      const keyNode = pair.key;
      if (!isScalar(keyNode)) {
        throw new FrontmatterError("unsupported non-scalar mapping key in agent frontmatter");
      }
      if (keyNode.value === "<<") {
        throw new FrontmatterError("YAML merge keys (`<<`) are not supported in agent frontmatter");
      }
      const id = keyIdentity(keyNode);
      if (seen.has(id)) {
        const noun = kind === "top" ? "top-level key" : "permission rule";
        throw new FrontmatterError(
          `duplicate ${noun} "${String(keyNode.value)}" cannot be safely transformed${atPosition(yamlText, keyNode)}`
        );
      }
      seen.add(id);
      const childKind = kind === "top" && keyNode.value === "permission" ? "permission" : kind;
      auditSecurity(pair.value, childKind, yamlText);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) auditSecurity(item, kind, yamlText);
  }
}

/**
 * Canonical allowlist validation of the parsed `permission` mapping.  Shared by
 * the transform and the classifier.  Returns `{ ok, error, rules }`.
 */
export function validatePermissionMapping(permissionMap, yamlText = "") {
  const items = permissionMap.items;
  if (items.length === 0) {
    return { ok: false, error: "empty permission block", rules: [] };
  }
  const first = items[0];
  if (
    !(isScalar(first.key) && first.key.value === "*") ||
    !isScalar(first.value) ||
    first.value.value !== "deny"
  ) {
    return {
      ok: false,
      error: `permission block must begin with a "*": deny wildcard rule${atPosition(yamlText, first)}`,
      rules: [],
    };
  }

  const rules = [];
  for (let i = 0; i < items.length; i++) {
    const pair = items[i];
    const key = String(pair.key.value);
    rules.push({ key, value: isScalar(pair.value) ? pair.value.value : undefined, pair });
    if (i === 0) continue; // the wildcard deny, already validated above

    if (hasOwn(OPT_IN_CONSTRAINED_RULES, key)) {
      if (!isScalar(pair.value)) {
        return {
          ok: false,
          error: `permission rule "${key}" must be a scalar value, not a nested mapping${atPosition(yamlText, pair)}`,
          rules,
        };
      }
      const expected = OPT_IN_CONSTRAINED_RULES[key];
      const val = pair.value.value;
      const isLegacy = hasOwn(OPT_IN_LEGACY_CONSTRAINED_RULES, key) && val === OPT_IN_LEGACY_CONSTRAINED_RULES[key];
      if (val !== expected && !isLegacy) {
        return {
          ok: false,
          error:
            `permission rule "${key}" must be "${expected}", found "${val}" — ` +
            `refusing to silently normalize a broader privilege${atPosition(yamlText, pair)}`,
          rules,
        };
      }
      continue;
    }

    if (key === "skill") {
      if (!isMap(pair.value) || pair.value.items.length === 0) {
        return {
          ok: false,
          error: `permission rule "skill" must be a nested mapping of skill grants${atPosition(yamlText, pair)}`,
          rules,
        };
      }
      for (const child of pair.value.items) {
        const childKey = String(child.key.value);
        const childValue = isScalar(child.value) ? child.value.value : undefined;
        if (!(childKey === "kusabi-*" || VETTED_SKILL_CHILD_RE.test(childKey)) || childValue !== "allow") {
          return {
            ok: false,
            error: `unsupported nested skill rule ("${childKey}"); only "kusabi-*": allow is supported${atPosition(yamlText, child)}`,
            rules,
          };
        }
      }
      continue;
    }

    if (isVettedToolKey(key)) {
      if (!isScalar(pair.value)) {
        return {
          ok: false,
          error: `permission rule "${key}" must be a scalar value, not a nested mapping${atPosition(yamlText, pair)}`,
          rules,
        };
      }
      if (pair.value.value !== "allow") {
        return {
          ok: false,
          error: `permission rule "${key}" must be "allow", found "${pair.value.value}"${atPosition(yamlText, pair)}`,
          rules,
        };
      }
      continue;
    }

    return {
      ok: false,
      error:
        `unsupported permission key "${key}"; the opt-in profile only permits "*: deny", ` +
        `the exact read/bash/StructuredOutput rules, and vetted sunaba_*/shiori*/kaiba_* tools${atPosition(yamlText, pair)}`,
      rules,
    };
  }
  return { ok: true, error: null, rules };
}

function findPair(map, keyValue) {
  return map.items.find((pair) => isScalar(pair.key) && pair.key.value === keyValue) || null;
}

/**
 * Strictly parse and canonically validate one agent document.
 *
 * @returns {{
 *   ok: true,
 *   fm: { yaml: string, rest: string },
 *   rootMap: object,
 *   permissionMap: object,
 *   permissionPair: object,
 *   wildcardPair: object,
 *   rules: Array<{ key: string, value: unknown, pair: object }>,
 *   name: string,
 *   description: string,
 * } | { ok: false, code: string, error: string }}
 */
export function analyzeAgentFrontmatter(content) {
  const fm = extractFrontmatter(content);
  if (!fm) {
    return { ok: false, code: "no-frontmatter", error: "no YAML frontmatter found in agent content" };
  }

  let doc;
  try {
    doc = parseStrictDocument(fm.yaml);
  } catch (err) {
    return { ok: false, code: "invalid-yaml", error: err.message };
  }

  const rootMap = doc.contents;
  if (!isMap(rootMap)) {
    return { ok: false, code: "not-mapping", error: "agent frontmatter must be a single YAML mapping" };
  }

  try {
    auditSecurity(rootMap, "top", fm.yaml);
  } catch (err) {
    return { ok: false, code: "invalid-yaml", error: err.message };
  }
  // Safety net: the parser flagged a duplicate that the AST walk somehow did
  // not surface.  Never fall through to a last-wins interpretation.
  if (doc.errors.some((e) => e.code === "DUPLICATE_KEY")) {
    return { ok: false, code: "invalid-yaml", error: "duplicate mapping keys cannot be safely transformed" };
  }

  const permissionPair = findPair(rootMap, "permission");
  if (!permissionPair) {
    return { ok: false, code: "no-permission", error: "no `permission:` block found in agent frontmatter" };
  }
  const permissionMap = permissionPair.value;
  if (!isMap(permissionMap)) {
    return { ok: false, code: "permission-not-mapping", error: "`permission` must be an ordered YAML mapping" };
  }

  const check = validatePermissionMapping(permissionMap, fm.yaml);
  if (!check.ok) {
    return { ok: false, code: "invalid-permission", error: check.error };
  }

  const namePair = findPair(rootMap, "name");
  const descPair = findPair(rootMap, "description");
  const name = namePair && isScalar(namePair.value) && typeof namePair.value.value === "string" ? namePair.value.value : "";
  const description =
    descPair && isScalar(descPair.value) && typeof descPair.value.value === "string" ? descPair.value.value : "";

  return {
    ok: true,
    fm,
    rootMap,
    permissionMap,
    permissionPair,
    wildcardPair: permissionMap.items[0],
    rules: check.rules,
    name,
    description,
  };
}
