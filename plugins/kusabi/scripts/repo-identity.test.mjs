import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseOwnerRepo, readOriginRepo } from "./repo-identity.mjs";

describe("parseOwnerRepo", () => {
  it("parses HTTPS, SCP-style SSH, and ssh:// URLs with optional .git", () => {
    for (const url of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "git@github.com:owner/repo",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
      "ssh://git@github.com/owner/repo.git",
    ]) {
      assert.equal(parseOwnerRepo(url), "owner/repo", url);
    }
    assert.equal(parseOwnerRepo("  https://github.com/owner/repo.git  "), "owner/repo");
  });

  it("rejects local paths, file URLs, missing and extra segments", () => {
    for (const url of [
      "/repos/owner/repo",
      "file:///repos/owner/repo",
      "https://github.com/owner",
      "https://github.com/owner/repo/extra",
      "https://github.com/../repo",
      "git@github.com:./repo.git",
    ]) {
      assert.equal(parseOwnerRepo(url), null, url);
    }
  });
});

describe("readOriginRepo", () => {
  it("returns a bounded reason when the injected lookup throws", () => {
    const result = readOriginRepo("/workspace", {
      run: () => { throw new Error("git remote unavailable from /host/cwd"); },
    });
    assert.deepEqual(result, {
      repo: null,
      repoReason: "git remote get-url failed",
    });
    assert.ok(result.repoReason.length > 0 && result.repoReason.length <= 100);
  });

  it("returns a reason for an unparseable origin URL", () => {
    const result = readOriginRepo("/workspace", {
      run: () => "file:///repos/owner/repo",
    });
    assert.deepEqual(result, {
      repo: null,
      repoReason: "unrecognised remote url",
    });
  });

  it("returns no origin reason for empty output", () => {
    const result = readOriginRepo("/workspace", { run: () => "  " });
    assert.deepEqual(result, { repo: null, repoReason: "no origin remote" });
  });

  it("returns the parsed repository and no reason", () => {
    const result = readOriginRepo("/workspace", {
      run: (cwd) => {
        assert.equal(cwd, "/workspace");
        return "git@github.com:owner/repo.git";
      },
    });
    assert.deepEqual(result, { repo: "owner/repo", repoReason: null });
  });
});
