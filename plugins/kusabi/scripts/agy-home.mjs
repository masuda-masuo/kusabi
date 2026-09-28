// agy-home.mjs — agy backend per-role HOME directory and permission resolution.
//
// Split out of agy-dispatch.mjs (pure move, no behaviour change): resolving the
// per-role HOME directory, asserting settings.json permissions, and extracting
// denied actions from output or conversation database.

import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { readJson, stateRoot } from "./state-paths.mjs";

// =========================================================================
// per-role HOME resolution \u2014 pure
// =========================================================================
//
// agy takes no allow/deny flags, but its permission table is per-HOME:
// `<HOME>/.gemini/antigravity-cli/settings.json` carries `permissions.allow`,
// the CLI derives that path from HOME and nothing else, and a dispatch under
// a separate HOME is governed by the separate table (measured 2026-09-22:
// a tool allow-listed only in the main HOME is refused under the separate
// one, so the main table does not leak).  So the per-role restriction that
// `--deny` cannot express IS expressible: give the role its own HOME.  The
// MCP config (`~/.gemini/config/mcp_config.json`, written by `agy mcp add`)
// and the always-on `~/.gemini/config/rules/AGENTS.md` are per-HOME too, so
// a role home scopes the whole permission surface, not just the allow-list.

/**
 * The kusabi config, read straight from the state root for the home
 * resolver's own use.  `agyDispatch` is handed no config (the dispatch
 * contract it shares with `dispatchWithFallback` / `claudeDispatch` carries
 * none, and the chain phases that call it never saw one), so the resolver
 * reads the ONE key it needs itself rather than threading a config object
 * through every phase \u2014 exactly the loadClaudeGuardConfig precedent.
 *
 * Read-only and fail-quiet: `readJson` returns null for a missing or
 * unparseable file.  A genuinely broken config never reaches here \u2014 every
 * command loads and validates it (loadConfig, kusabi-companion.mjs) before
 * any dispatch happens.
 *
 * @returns {object|null}
 */
export function loadAgyHomeConfig() {
  return readJson(path.join(stateRoot(), "config.json"));
}

/**
 * Resolve the HOME an agy dispatch should run under, from the `agy.homes`
 * map in the kusabi config.
 *
 * Config shape (documented in README.md, "Backends"):
 *
 *   { "agy": { "homes": { "implement": "/home/u/.agy-homes/implement",
 *                         "review":    "/home/u/.agy-homes/review",
 *                         "default":   "/home/u/.agy-homes/default" } } }
 *
 * `home: null` means "do not override HOME" \u2014 the spawn is byte-identical
 * to today's dispatch.  Resolution table \u2014 every row is a test:
 *
 *   | input | result | reason |
 *   |---|---|---|
 *   | no config file, or not an object | `null` | `no-config` |
 *   | `agy.homes` absent | `null` | `absent` |
 *   | `agy.homes` not an object (string, array, number) | `null` | `malformed` |
 *   | `phase` has an entry, non-empty string | that path | `phase` |
 *   | `phase` absent from `homes`, `homes.default` present | the default path | `default` |
 *   | `phase` absent and no `default` | `null` | `absent` |
 *   | the selected value is `""`, `false`, `0`, `null`, a number or an object | `null` | `malformed` |
 *   | the selected value is a relative path | **throw** | \u2014 |
 *
 * There is deliberately NO `rework` row: a rework round dispatches as the
 * implement phase (`runImplementPhase` passes `phase: "implement"` for every
 * round), so it is meant to share `homes.implement`.  A `rework` key would
 * document a home no production caller ever selects, and a phase that is not
 * an entry falls to `default` or `null` — never to another seat's home.
 *
 * A relative path throws rather than resolving: the spawn's cwd is the repo
 * under test, so a relative HOME would silently point somewhere different per
 * dispatch.  The message names the key and the value.
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.phase] \u2014 the dispatch's phase; a key
 *        into `homes`.
 * @param {object|null|undefined} [opts.config] \u2014 output of
 *        loadAgyHomeConfig().
 * @returns {{ home: string|null, reason: string }}
 * @throws {Error} When the selected value is a relative path.
 */
export function resolveAgyHome({ phase, config }) {
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return { home: null, reason: "no-config" };
  }
  const agy = config.agy;
  const homes = (agy === null || typeof agy !== "object" || Array.isArray(agy)) ? undefined : agy.homes;
  if (homes === undefined) return { home: null, reason: "absent" };
  if (homes === null || typeof homes !== "object" || Array.isArray(homes)) {
    return { home: null, reason: "malformed" };
  }

  // Selection: the phase's own entry wins; otherwise `default`.  Presence is
  // what selects; the selected VALUE is validated below, so a present-but-
  // malformed entry reports `malformed`, never a silent fall-through.  An
  // unrecognised or null phase falls to `default` or `null` — never to
  // another seat's home (there is no rework row on purpose, see the doc
  // comment).
  let key;
  let value;
  let reason;
  if (typeof phase === "string" && phase !== "" && Object.hasOwn(homes, phase)) {
    key = phase;
    value = homes[phase];
    reason = "phase";
  } else if (Object.hasOwn(homes, "default")) {
    key = "default";
    value = homes.default;
    reason = "default";
  } else {
    return { home: null, reason: "absent" };
  }

  if (typeof value !== "string" || value === "") {
    return { home: null, reason: "malformed" };
  }
  if (!path.isAbsolute(value)) {
    throw new Error(
      `agy backend: agy.homes.${key} must be an ABSOLUTE path, got "${value}" \u2014 ` +
      "a relative HOME would silently point somewhere different per dispatch " +
      "(the spawn's cwd is the repo under test). Use an absolute path, or " +
      "remove the key to run under the ambient HOME."
    );
  }
  return { home: value, reason };
}

/**
 * The config key that produced a resolved home, for error messages.
 *
 * The resolver's contract is `{ home, reason }`; the key is recoverable from
 * the reason, so it is derived here rather than carried on the record.  Only
 * the two home-producing reasons are ever passed.
 *
 * @param {string} reason \u2014 a `reason` from resolveAgyHome.
 * @param {string|null|undefined} [phase]
 * @returns {string} e.g. `agy.homes.implement`.
 */
export function agyHomeConfigKey(reason, phase) {
  if (reason === "default") return "agy.homes.default";
  return `agy.homes.${typeof phase === "string" ? phase : ""}`;
}

/**
 * The settings.json an agy role's permission table lives in.
 *
 * This is the ONE file this module reads from a role home.  It is derived
 * from HOME and nothing else (measured 2026-09-22), so the same path that
 * the CLI consults is the path this module checks.
 *
 * @param {string} home \u2014 a resolved role home.
 * @returns {string}
 */
export function agyHomeSettingsPath(home) {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Fail-closed check on a resolved role home, run BEFORE the spawn.
 *
 * When `agy.homes` names a home, kusabi requires that home's permission
 * table to be usable: the settings.json must exist, parse as JSON, and carry
 * `permissions` as an object with `permissions.allow` either absent or an
 * array.  Anything else throws a config-level error (never a failed job):
 * a missing or unreadable role table would silently fall back to the
 * ambient HOME \u2014 the operator's own machine-wide table \u2014 running with
 * MORE access than configured, which is the failure this whole mechanism
 * exists to prevent.  There is deliberately no fallback path.
 *
 * Reading this file is the only filesystem access the HOME mechanism adds;
 * it is a read, and it happens once per dispatch, before anything is
 * spawned.
 *
 * @param {object} opts
 * @param {string} opts.home \u2014 the resolved role home.
 * @param {string|null|undefined} [opts.phase] \u2014 named in the error.
 * @param {string} opts.configKey \u2014 e.g. `agy.homes.implement`, named in the
 *        error so the operator can find the line to fix.
 * @throws {Error} When the table is missing, unparseable, or misshaped.
 */
export function assertAgyHomeSettings({ home, phase, configKey }) {
  const settingsPath = agyHomeSettingsPath(home);
  const phaseName = JSON.stringify(phase ?? null);
  const base = `agy backend: phase ${phaseName} resolves HOME "${home}" from ${configKey}, `;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    throw new Error(
      `${base}but ${settingsPath} is missing or not readable as JSON (${err.message}) \u2014 ` +
      "kusabi refuses rather than falling back to the ambient HOME: a missing role table would " +
      "silently widen the permission surface back to the operator's own machine-wide table. " +
      `Fix the file, or remove ${configKey}.`
    );
  }
  const problem =
    parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
      ? "the file does not parse to a JSON object"
      : (() => {
          const permissions = parsed.permissions;
          if (permissions !== undefined && (permissions === null || typeof permissions !== "object" || Array.isArray(permissions))) {
            return "`permissions` is not an object";
          }
          const allow = permissions === undefined ? undefined : permissions.allow;
          if (allow !== undefined && !Array.isArray(allow)) {
            return "`permissions.allow` is present but not an array";
          }
          return null;
        })();
  if (problem !== null) {
    throw new Error(
      `${base}but ${settingsPath} is not a usable permission table: ${problem}. ` +
      "kusabi refuses rather than falling back to the ambient HOME: a malformed role table would " +
      "silently widen the permission surface back to the operator's own machine-wide table. " +
      `Fix the file, or remove ${configKey}.`
    );
  }
}

// =========================================================================
// denied_actions \u2014 pure
// =========================================================================
//
// Headless agy cannot prompt, so a tool that is not allow-listed is
// auto-denied and the terminal result reports it as `denied_actions` while
// `status` stays SUCCESS and `response` is empty:
//
//   {"status":"SUCCESS","response":"","denied_actions":[{"action":"command",
//    "display_name":"RunCommand"}]}
//
// Without reading that field the result is indistinguishable from "the
// provider returned nothing" (observed 2026-08-22: an implement worker chose
// the host `bash`, was denied, and burned 84 seconds with zero edits).  The
// field is taken DEFENSIVELY: entries may lack `display_name`, and the field
// may be absent entirely on older CLI versions.

/**
 * The denied tool-call names a result reports, as a bare string array.
 *
 * Each entry contributes its `action` when that is a non-empty string,
 * falling back to `display_name` when the action is missing \u2014 a name is
 * better than a dropped entry.  Entries that are not objects, and entries
 * with neither field, are skipped.  Absent or non-array `denied_actions`
 * yields `[]` (older CLI versions).
 *
 * @param {object|null|undefined} parsed \u2014 an agy result object.
 * @returns {string[]}
 */
export function agyDeniedActionNames(parsed) {
  return collectAgyDeniedActions(parsed).map((d) => d.name);
}

/**
 * The structured reading of `denied_actions`: `name` for the record,
 * `label` for the error text (the action with its display name attached).
 *
 * @param {object|null|undefined} parsed
 * @returns {{name: string, label: string}[]}
 */
export function collectAgyDeniedActions(parsed) {
  const raw = parsed?.denied_actions;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const action = typeof entry.action === "string" && entry.action.trim() !== "" ? entry.action : null;
    const displayName = typeof entry.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name : null;
    if (action === null && displayName === null) continue;
    const name = action ?? displayName;
    const label = action !== null && displayName !== null ? `${action} (${displayName})` : name;
    out.push({ name, label });
  }
  return out;
}

/**
 * Identify the MCP tool behind an `mcp` denial by reading agy's own
 * per-conversation SQLite record.
 *
 * WHY this exists.  `denied_actions` carries only the action CLASS: for an
 * MCP call the entry is `{"action":"mcp","display_name":"CallMcpTool"}` —
 * "one MCP call was denied" is known, *which* tool is not, and `cli.log` does
 * not name it either (`soft-denying tool confirmation "CallMcpTool" at step
 * 20`).  The whole point of recording a denial is to fix the allowlist, and
 * the line to add cannot be derived from any of that.  The name does exist,
 * as plaintext inside a protobuf BLOB in agy's conversation database:
 *
 *   <home>/.gemini/antigravity-cli/conversations/<conversation_id>.db
 *
 * whose `steps.step_payload` contains `{"Arguments":{...},"ServerName":
 * "sunaba","ToolName":"sandbox_list_containers",...}`.  Reading it is the
 * ONLY way to turn a class into a fixable line.
 *
 * WHY "last matching row, status ≠ 3".  The rule was derived from measured
 * runs (12 conversations, 2026-09): `status` 3 is a COMPLETED step, while a
 * denied tool step carries 6 or 7.  The LAST tool step is the one that
 * governs — an earlier failure followed by a later success must report
 * null, because that later step belongs to a call the model recovered from,
 * and attributing the denial to it would be a guess.  `status ≠ 3` is
 * deliberately NOT `status ∈ {6, 7}`: the two observed denial statuses are
 * the sample we have seen, not an enumeration we can trust the CLI to stop
 * at, so the rule keys on the one status that is certain (3 = done) rather
 * than on the ones that merely were observed.
 *
 * DEFENSIVE BY CONTRACT.  This is diagnostic enrichment — it must never
 * break the dispatch.  Every failure — missing file, not a database, no
 * `steps` table, no matching row, an unreadable BLOB — returns `null`
 * instead of throwing, and the handle is closed on every path including the
 * failure paths.  Nothing else in the conversation database is read: not
 * prompts, not usage, not metadata.  This lookup exists for denial
 * diagnosis and nothing else.
 *
 * @param {object} opts
 * @param {string} opts.dbPath — the conversation database to read.
 * @returns {{server: string, tool: string}|null}
 */
export function agyDeniedToolFromConversation({ dbPath }) {
  if (typeof dbPath !== "string" || dbPath === "") return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // Missing file, not a SQLite database, unreadable — all the same to
    // the caller: nothing was identified.
    return null;
  }
  try {
    let rows;
    try {
      rows = db.prepare("SELECT idx, status, step_payload FROM steps ORDER BY idx").all();
    } catch {
      // No `steps` table (or an unreadable one): nothing to conclude.
      return null;
    }
    let last = null;
    for (const row of rows) {
      const raw = row.step_payload;
      if (raw === null || raw === undefined) continue;
      // BLOBs come back as Uint8Array; decode as latin1 (each byte is one
      // character, so the ASCII JSON substring inside the protobuf noise is
      // preserved verbatim — this is the "find it inside a blob" path).
      const text =
        typeof raw === "string" ? raw
        : raw instanceof Uint8Array ? Buffer.from(raw).toString("latin1")
        : String(raw);
      const match = text.match(/"ServerName":"([^"]+)","ToolName":"([^"]+)"/);
      if (match !== null) {
        last = { server: match[1], tool: match[2], status: row.status };
      }
    }
    if (last === null) return null;
    // 3 is a completed step.  The last tool step of a run whose denial is
    // NOT this call is exactly that shape — reporting its tool would
    // misattribute the denial (see the "last matching row" note above).
    if (last.status === 3) return null;
    return { server: last.server, tool: last.tool };
  } finally {
    db.close();
  }
}
