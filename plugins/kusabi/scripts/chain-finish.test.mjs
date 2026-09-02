import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source guard: runChainDriver's function body must not contain nested
 * function definitions for finishRound / finaliseChain / finaliseProvisionalChain
 * (kusabi #422 Job 3).  These were lifted to chain-finish.mjs.
 */
describe("chain-finish source guard", () => {
  it("runChainDriver does not contain nested finishRound / finaliseChain / finaliseProvisionalChain", () => {
    const driverSource = fs.readFileSync(
      path.join(__dirname, "chain-driver.mjs"),
      "utf8",
    );

    // Find the runChainDriver function body: from the export line to the next
    // top-level export (or end of file).
    const exportStart = driverSource.indexOf("export async function runChainDriver(");
    assert.ok(exportStart !== -1, "runChainDriver must be exported");

    // Find the next top-level export after runChainDriver
    const afterDriver = driverSource.indexOf("\nexport ", exportStart + 1);
    const driverBody = afterDriver !== -1
      ? driverSource.slice(exportStart, afterDriver)
      : driverSource.slice(exportStart);

    // These patterns must NOT appear as nested function definitions inside
    // runChainDriver.  A leading `function` keyword (possibly after
    // whitespace/indentation) followed by the name indicates a nested def.
    const nestedPatterns = [
      /(?:^|\n)\s+function\s+finishRound\s*\(/m,
      /(?:^|\n)\s+function\s+finaliseChain\s*\(/m,
      /(?:^|\n)\s+function\s+finaliseProvisionalChain\s*\(/m,
    ];

    for (const pattern of nestedPatterns) {
      assert.ok(
        !pattern.test(driverBody),
        `runChainDriver must not contain a nested ${pattern.source} definition`,
      );
    }
  });

  it("chain-finish.mjs exports finishRound, finaliseChain, finaliseProvisionalChain", () => {
    const finishSource = fs.readFileSync(
      path.join(__dirname, "chain-finish.mjs"),
      "utf8",
    );

    assert.ok(
      /export\s+async\s+function\s+finishRound\s*\(/.test(finishSource),
      "chain-finish.mjs must export finishRound",
    );
    assert.ok(
      /export\s+function\s+finaliseChain\s*\(/.test(finishSource),
      "chain-finish.mjs must export finaliseChain",
    );
    assert.ok(
      /export\s+function\s+finaliseProvisionalChain\s*\(/.test(finishSource),
      "chain-finish.mjs must export finaliseProvisionalChain",
    );
  });

  it("chain-finish.mjs does not import chain-cmd.mjs or kusabi-companion.mjs", () => {
    const finishSource = fs.readFileSync(
      path.join(__dirname, "chain-finish.mjs"),
      "utf8",
    );

    assert.ok(
      !/from\s+["']\.\/chain-cmd\.mjs["']/.test(finishSource),
      "chain-finish.mjs must not import chain-cmd.mjs",
    );
    assert.ok(
      !/from\s+["']\.\/kusabi-companion\.mjs["']/.test(finishSource),
      "chain-finish.mjs must not import kusabi-companion.mjs",
    );
  });

  it("chain-driver.mjs does not re-export finishRound / finaliseChain / finaliseProvisionalChain", () => {
    const driverSource = fs.readFileSync(
      path.join(__dirname, "chain-driver.mjs"),
      "utf8",
    );

    // These should only be imported, not re-exported
    const reExportPatterns = [
      /export\s*\{[^}]*\bfinishRound\b/,
      /export\s*\{[^}]*\bfinaliseChain\b/,
      /export\s*\{[^}]*\bfinaliseProvisionalChain\b/,
    ];

    for (const pattern of reExportPatterns) {
      assert.ok(
        !pattern.test(driverSource),
        `chain-driver.mjs must not re-export ${pattern.source}`,
      );
    }
  });
});
