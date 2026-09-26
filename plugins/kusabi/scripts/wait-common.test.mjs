import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mtimeOf, defaultSleep } from "./wait-common.mjs";

describe("wait-common", () => {
  describe("mtimeOf", () => {
    it("returns exact mtimeMs for an existing file", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-wait-common-test-"));
      try {
        const filePath = path.join(tmpDir, "sample.txt");
        fs.writeFileSync(filePath, "test content");
        const stat = fs.statSync(filePath);
        assert.equal(mtimeOf(filePath), stat.mtimeMs);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns 0 for a missing path", () => {
      const missingPath = path.join(os.tmpdir(), `nonexistent-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      assert.equal(mtimeOf(missingPath), 0);
    });
  });

  describe("defaultSleep", () => {
    it("resolves to undefined after at least the requested delay", async () => {
      const start = performance.now();
      const delayMs = 25;
      const result = await defaultSleep(delayMs);
      const elapsed = performance.now() - start;

      assert.equal(result, undefined);
      // Node's timer clock has millisecond granularity, so a timer may fire
      // up to 1ms before the requested delay as measured here.
      assert.ok(elapsed >= delayMs - 1, `expected elapsed >= ${delayMs - 1}ms, got ${elapsed}ms`);
    });
  });
});
