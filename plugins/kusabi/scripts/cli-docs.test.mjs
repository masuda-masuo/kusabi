// Validate stable CLI contracts against runtime tables, not prose snapshots.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  BACKEND_ENTRY_PREFIXES,
  BUILTIN_DEFAULT_CHAIN,
  resolveModelBackend,
} from "./cli.mjs";
import { BACKENDS, resolveDispatchBackend } from "./kusabi-companion.mjs";

const readme = fs.readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
const help = execFileSync(process.execPath, [
  new URL("./kusabi-companion.mjs", import.meta.url).pathname, "--help",
], { encoding: "utf8", timeout: 10000 });

function backendLists(text) {
  return [...text.matchAll(/--backend ([a-z]+(?:\|[a-z]+)+)/g)]
    .map((match) => match[1].split("|"));
}

function checkBackendLists(text, backends = BACKENDS) {
  const lists = backendLists(text);
  assert.ok(lists.length > 0, "missing --backend choices");
  for (const list of lists) {
    assert.deepEqual(list, backends, "documented --backend choices differ from runtime");
  }
}

function modelParagraph(text) {
  const start = text.indexOf("A route prefixed with");
  const end = text.indexOf("### Variant syntax", start);
  assert.ok(start >= 0 && end > start, "missing model routing explanation");
  return text.slice(start, end);
}

function checkPrefixes(text, prefixes = BACKEND_ENTRY_PREFIXES) {
  const documented = [...text.matchAll(/`([a-z]+\/)\`/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(documented)].sort(), prefixes.map((entry) => entry.prefix).sort(),
    "documented model prefixes differ from runtime");
}

function documentedDefaultChain(text) {
  const configs = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]))
    .filter((config) => config.models?.chain);
  assert.equal(configs.length, 1, "expected one default model-chain example");
  return configs[0].models.chain;
}

describe("CLI documentation contracts", () => {
  it("README and executed CLI help list every supported backend in each flag usage", () => {
    checkBackendLists(readme);
    checkBackendLists(help);
  });

  it("README model prefixes match the routing table and actually select that backend", () => {
    checkPrefixes(modelParagraph(readme));
    assert.deepEqual(["opencode", ...BACKEND_ENTRY_PREFIXES.map((entry) => entry.backend)], BACKENDS);
    for (const { prefix, backend } of BACKEND_ENTRY_PREFIXES) {
      assert.deepEqual(resolveModelBackend(prefix + "example"), { backend, model: "example" });
      assert.ok(help.includes(prefix), "CLI help must document " + prefix);
    }
    assert.ok(modelParagraph(readme).includes("`provider/model[:variant]`"));
    assert.deepEqual(resolveModelBackend("provider/model:max"),
      { backend: "opencode", model: "provider/model:max" });
    assert.deepEqual(resolveModelBackend("alias"), { backend: null, model: "alias" });
  });

  it("the documented model/backend conflict is rejected before dispatch for every prefix", () => {
    const paragraph = modelParagraph(readme).replace(/\s+/g, " ");
    assert.match(paragraph, /If `--backend` contradicts.*`--model`, the command is rejected/);
    for (const { prefix, backend } of BACKEND_ENTRY_PREFIXES) {
      assert.throws(() => resolveDispatchBackend({
        flags: { backend: "opencode", model: prefix + "example" }, config: null,
      }), (error) => error.flagError === true &&
        error.message.includes("--backend opencode conflicts with --model " + prefix + "example") &&
        error.message.includes(backend));
    }
  });

  it("README default chain preserves runtime tier and route order", () => {
    assert.deepEqual(documentedDefaultChain(readme), BUILTIN_DEFAULT_CHAIN);
  });

  it("detects an added or renamed backend when documentation is unchanged", () => {
    assert.throws(() => checkBackendLists(readme, [...BACKENDS, "newbackend"]),
      /documented --backend choices/);
    assert.throws(() => checkBackendLists(help, BACKENDS.map((name) =>
      name === "cursor" ? "renamed" : name)), /documented --backend choices/);
  });

  it("detects missing, extra, and renamed prefixes without snapshotting prose", () => {
    const paragraph = modelParagraph(readme);
    assert.throws(() => checkPrefixes(paragraph.replace("`cursor/`", "Cursor")),
      /documented model prefixes/);
    assert.throws(() => checkPrefixes(paragraph + " `other/`"),
      /documented model prefixes/);
    assert.throws(() => checkPrefixes(paragraph, BACKEND_ENTRY_PREFIXES.map((entry) =>
      entry.backend === "cursor" ? { ...entry, prefix: "renamed/" } : entry)),
    /documented model prefixes/);
    checkPrefixes(paragraph.replace("for example", "for instance"));
  });
});
