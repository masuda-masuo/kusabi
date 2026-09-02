// claude-mcp.test.mjs — tests for MCP configuration extract and transforms (kusabi #426).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  extractSunabaMcp,
  extractKaibaMcp,
  applyWorkerKaibaIdentity,
  applySunabaProfile,
} from "./claude-mcp.mjs";

// Source guard: moved names must NOT be defined in claude-dispatch.mjs
// after the move to claude-mcp.mjs (kusabi #426).
describe("claude-mcp source guard", () => {
  it("claude-dispatch.mjs contains no export function extractSunabaMcp(", () => {
    const dispatchSrc = fs.readFileSync(
      path.join(import.meta.dirname, "claude-dispatch.mjs"),
      "utf8",
    );
    assert.ok(
      !dispatchSrc.includes("export function extractSunabaMcp("),
      "claude-dispatch.mjs must not export extractSunabaMcp",
    );
  });
});

describe("extractSunabaMcp", () => {
  it("extracts the sunaba server entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const sunaba = { command: "npx", args: ["-y", "sunaba"] };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba, other: { command: "echo" } } }), "utf8");
    assert.deepEqual(extractSunabaMcp(file), sunaba);
  });

  it("throws a clear error when the entry is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "echo" } } }), "utf8");
    assert.throws(() => extractSunabaMcp(file), /no mcpServers\.sunaba entry/);
  });

  it("throws a clear error when the file is unreadable", () => {
    assert.throws(() => extractSunabaMcp("/nonexistent/never.json"), /cannot read MCP source config/);
  });
});

describe("extractKaibaMcp", () => {
  it("extracts the kaiba server entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const kaiba = { command: "/usr/local/bin/kaiba", env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "claude" } };
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba } }), "utf8");
    assert.deepEqual(extractKaibaMcp(file), kaiba);
  });

  it("returns null when the entry is absent — kaiba is optional, this must NOT throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" } } }), "utf8");
    assert.equal(extractKaibaMcp(file), null);
  });

  it("throws the SAME read error as extractSunabaMcp — an unreadable config is a config error, not an absence", () => {
    assert.throws(() => extractKaibaMcp("/nonexistent/never.json"), /cannot read MCP source config/);
  });

  it("throws the SAME parse error as extractSunabaMcp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    assert.throws(() => extractKaibaMcp(file), /is not valid JSON/);
  });

  it("rejects a string, a number, a boolean, an array and null — each is a config error, not an absence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const junk = [
      ["string", "kaiba"],
      ["number", 7],
      ["boolean", true],
      ["array", ["kaiba"]],
      ["null", null],
    ];
    for (const [label, value] of junk) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: value } }), "utf8");
      assert.throws(
        () => extractKaibaMcp(file),
        (err) => {
          // A reader must be able to tell this apart from the missing-sunaba
          // failure: the message names the kaiba key, says the entry is not
          // a server entry, and tells the operator that removing the key
          // restores the previous behaviour.
          assert.match(err.message, /mcpServers\.kaiba/, "the error must name the key");
          assert.match(err.message, /not a server entry/, "the error must say the entry is not a server entry");
          assert.match(
            err.message,
            /remove the mcpServers\.kaiba key/,
            "the error must tell the operator that removing the key restores the previous behaviour",
          );
          return true;
        },
        `${label} entry must throw`,
      );
    }
  });

  it("the error says what the entry was found to be", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const cases = [
      ["string", "kaiba", /is a string, not a server entry/],
      ["number", 7, /is a number, not a server entry/],
      ["boolean", true, /is a boolean, not a server entry/],
      ["array", ["kaiba"], /is an array, not a server entry/],
      ["null", null, /is null, not a server entry/],
    ];
    for (const [label, value, re] of cases) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: value } }), "utf8");
      assert.throws(() => extractKaibaMcp(file), re, `${label}: the message must say what was found`);
    }
  });

  it("rejects an object with no field that could start a server — {} and junk objects are malformed, not absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const junk = [{}, { foo: 1 }, { env: { KAIBA_AGENT: "claude" } }];
    for (const value of junk) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: value } }), "utf8");
      assert.throws(() => extractKaibaMcp(file), /an object with none of the server-launching fields/);
    }
  });

  it("rejects an object whose only launch-declaring field is type — type names the transport kind, it launches nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const junk = [{ type: "stdio" }, { type: "http" }, { type: "sse" }];
    for (const value of junk) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: value } }), "utf8");
      assert.throws(
        () => extractKaibaMcp(file),
        (err) => {
          // Same message shape as the other rejections: the key is named,
          // the entry is not a server entry, and what was wrong with it is
          // spelled out (it has none of the server-launching fields).
          assert.match(err.message, /mcpServers\.kaiba/, "the error must name the key");
          assert.match(err.message, /not a server entry/, "the error must say the entry is not a server entry");
          assert.match(
            err.message,
            /an object with none of the server-launching fields \(command, url\)/,
            "the message must say what was wrong with the entry",
          );
          return true;
        },
        `${JSON.stringify(value)} entry must throw`,
      );
    }
  });

  it("accepts type beside a launcher — type with command or url is a normal entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const entries = [
      { type: "stdio", command: "/usr/local/bin/kaiba" },
      { type: "http", url: "http://localhost:8890/mcp" },
      { type: "http", url: "http://localhost:8890/mcp", headers: { Authorization: "Bearer x" } },
    ];
    for (const entry of entries) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: entry } }), "utf8");
      assert.deepEqual(extractKaibaMcp(file), entry);
    }
  });

  it("accepts any object that can launch a server — command or url — without judging its contents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-claude-mcp-"));
    const file = path.join(dir, "claude.json");
    const entries = [
      { command: "/usr/local/bin/kaiba" },
      { command: "/usr/local/bin/kaiba", args: ["--stdio"], env: { KAIBA_WORKSPACE: "dev" } },
      { url: "http://localhost:8890/sse" },
      { type: "http", url: "http://localhost:8890/mcp" },
      // Contents are NOT judged here: whether the command exists or the url
      // answers belongs to claude at connect time (kusabi #279 follow-up).
      { command: "/definitely/not/on/this/machine" },
    ];
    for (const entry of entries) {
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { sunaba: { command: "npx" }, kaiba: entry } }), "utf8");
      assert.deepEqual(extractKaibaMcp(file), entry);
    }
  });
});

describe("applyWorkerKaibaIdentity", () => {
  it("forces env.KAIBA_AGENT=worker no matter what the source entry said, preserving the rest", () => {
    const entry = {
      command: "/usr/local/bin/kaiba",
      args: ["--stdio"],
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "claude" },
    };
    assert.deepEqual(applyWorkerKaibaIdentity(entry), {
      command: "/usr/local/bin/kaiba",
      args: ["--stdio"],
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "worker" },
    });
  });

  it("stamps env.KAIBA_JOB when jobId is provided", () => {
    const entry = {
      command: "/usr/local/bin/kaiba",
      args: ["--stdio"],
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "claude" },
    };
    assert.deepEqual(applyWorkerKaibaIdentity(entry, "job-abc"), {
      command: "/usr/local/bin/kaiba",
      args: ["--stdio"],
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "worker", KAIBA_JOB: "job-abc" },
    });
    // source is not mutated
    assert.deepEqual(entry, {
      command: "/usr/local/bin/kaiba",
      args: ["--stdio"],
      env: { KAIBA_WORKSPACE: "dev", KAIBA_AGENT: "claude" },
    });
  });

  it("does not stamp KAIBA_JOB when jobId is omitted, null, or empty string", () => {
    const entry = { command: "/usr/local/bin/kaiba" };
    assert.deepEqual(applyWorkerKaibaIdentity(entry), {
      command: "/usr/local/bin/kaiba",
      env: { KAIBA_AGENT: "worker" },
    });
    assert.deepEqual(applyWorkerKaibaIdentity(entry, null), {
      command: "/usr/local/bin/kaiba",
      env: { KAIBA_AGENT: "worker" },
    });
    assert.deepEqual(applyWorkerKaibaIdentity(entry, ""), {
      command: "/usr/local/bin/kaiba",
      env: { KAIBA_AGENT: "worker" },
    });
  });

  it("throws when jobId is invalid", () => {
    const entry = { command: "/usr/local/bin/kaiba" };
    assert.throws(() => applyWorkerKaibaIdentity(entry, "bad id"), /invalid KAIBA_JOB id.*bad id/);
    assert.throws(() => applyWorkerKaibaIdentity(entry, "job@123"), /invalid KAIBA_JOB id.*job@123/);
    assert.throws(() => applyWorkerKaibaIdentity(entry, 123), /invalid KAIBA_JOB id/);
  });

  it("adds the env block when the source entry has none", () => {
    assert.deepEqual(
      applyWorkerKaibaIdentity({ command: "/usr/local/bin/kaiba" }),
      { command: "/usr/local/bin/kaiba", env: { KAIBA_AGENT: "worker" } },
    );
  });

  it("never mutates the source entry — the rewrite comes back on a copy", () => {
    const entry = { command: "/usr/local/bin/kaiba", env: { KAIBA_AGENT: "claude" } };
    applyWorkerKaibaIdentity(entry);
    assert.deepEqual(entry, { command: "/usr/local/bin/kaiba", env: { KAIBA_AGENT: "claude" } });
  });

  it("passes an absent entry through as absent", () => {
    assert.equal(applyWorkerKaibaIdentity(null), null);
    assert.equal(applyWorkerKaibaIdentity(undefined), undefined);
  });

  it("passes a non-object entry through unchanged", () => {
    const entry = "kaiba";
    assert.equal(applyWorkerKaibaIdentity(entry), entry);
  });
});

describe("applySunabaProfile", () => {
  it("appends profile= to a plain URL", () => {
    const entry = { type: "http", url: "http://127.0.0.1:8750/mcp" };
    assert.deepEqual(applySunabaProfile(entry, "implement"), {
      type: "http",
      url: "http://127.0.0.1:8750/mcp?profile=implement",
    });
    // The source entry is never mutated.
    assert.equal(entry.url, "http://127.0.0.1:8750/mcp");
  });

  it("preserves existing query parameters", () => {
    const out = applySunabaProfile({ url: "http://127.0.0.1:8750/mcp?token=abc" }, "review");
    assert.equal(out.url, "http://127.0.0.1:8750/mcp?token=abc&profile=review");
  });

  it("leaves a pre-existing profile= untouched (an explicit source profile wins)", () => {
    const entry = { url: "http://127.0.0.1:8750/mcp?profile=issue" };
    const out = applySunabaProfile(entry, "implement");
    assert.equal(out.url, "http://127.0.0.1:8750/mcp?profile=issue");
    assert.equal(out, entry); // pass-through, not a copy
  });

  it("passes a stdio entry (no url) through unchanged — profiles are an HTTP query feature", () => {
    const entry = { command: "npx", args: ["-y", "@sunaba/mcp-server"] };
    assert.equal(applySunabaProfile(entry, "implement"), entry);
  });

  it("is a no-op when no profile was resolved", () => {
    const entry = { url: "http://127.0.0.1:8750/mcp" };
    assert.equal(applySunabaProfile(entry, null), entry);
    assert.equal(applySunabaProfile(entry, undefined), entry);
  });
});
