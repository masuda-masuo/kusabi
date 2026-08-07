import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseOrchestratorSignature,
  parseDeliverables,
  parseSmoke,
  hasSectionHeading,
  parseChangedPaths,
  briefRequestsPublish,
} from "./brief-parsing.mjs";

// parseOrchestratorSignature
// ---------------------------------------------------------------------------

describe("parseOrchestratorSignature", () => {
  it("parses a full signature from the first line", () => {
    const brief = "Orchestrator: claude-fable-5 | session dfbdc7dc | 2026-07-22\n\nDo the thing.";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: "dfbdc7dc",
      date: "2026-07-22",
    });
  });

  it("parses signature from second line", () => {
    const brief = "# Brief\nOrchestrator: gpt-4 | session abc123 | 2026-01-01\n\nDo stuff";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "gpt-4",
      session: "abc123",
      date: "2026-01-01",
    });
  });

  it("parses signature from fifth line (last scanned)", () => {
    const brief = "line 1\nline 2\nline 3\nline 4\nOrchestrator: deepseek-v4 | session xyz | 2026-12-31";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "deepseek-v4",
      session: "xyz",
      date: "2026-12-31",
    });
  });

  it("returns null when signature is beyond first 5 lines", () => {
    const brief = "a\nb\nc\nd\ne\nOrchestrator: claude | session s1 | 2026-01-01";
    const result = parseOrchestratorSignature(brief);
    assert.equal(result, null);
  });

  it("returns null when no signature line exists", () => {
    const brief = "Just a regular brief with no orchestrator line.\nDo the work.";
    const result = parseOrchestratorSignature(brief);
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseOrchestratorSignature(""), null);
  });

  it("returns null for null/undefined input", () => {
    assert.equal(parseOrchestratorSignature(null), null);
    assert.equal(parseOrchestratorSignature(undefined), null);
  });

  it("handles missing parts gracefully (only model present)", () => {
    const brief = "Orchestrator: claude-fable-5";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: null,
      date: null,
    });
  });

  it("handles missing session and date", () => {
    const brief = "Orchestrator: claude-fable-5 |  | 2026-07-22";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: null,
      date: "2026-07-22",
    });
  });

  it("handles malformed separators (no pipes)", () => {
    const brief = "Orchestrator: just a string without pipes";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "just a string without pipes",
      session: null,
      date: null,
    });
  });

  it("strips 'session ' prefix from the session field", () => {
    const brief = "Orchestrator: claude-4 | session abc-def | 2026-03-15";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-4",
      session: "abc-def",
      date: "2026-03-15",
    });
  });

  it("never throws on malformed input", () => {
    assert.doesNotThrow(() => parseOrchestratorSignature(null));
    assert.doesNotThrow(() => parseOrchestratorSignature(undefined));
    assert.doesNotThrow(() => parseOrchestratorSignature(42));
    assert.doesNotThrow(() => parseOrchestratorSignature({}));
    assert.doesNotThrow(() => parseOrchestratorSignature(""));
    assert.doesNotThrow(() => parseOrchestratorSignature("Orchestrator:"));
  });
});

// parseDeliverables — ## Deliverables section parsing
// ---------------------------------------------------------------------------

describe("parseDeliverables", () => {
  it("returns [] for text without ## Deliverables section", () => {
    assert.deepEqual(parseDeliverables("some brief text\n## Other section\ncontent"), []);
  });

  it("returns [] for empty string", () => {
    assert.deepEqual(parseDeliverables(""), []);
  });

  it("returns [] for null/undefined", () => {
    assert.deepEqual(parseDeliverables(null), []);
    assert.deepEqual(parseDeliverables(undefined), []);
  });

  it("parses backtick-quoted paths from bullet list", () => {
    const text = "## Deliverables\n- `plugins/kusabi/scripts/foo.mjs`\n- `docs/DESIGN.md`\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"]);
  });

  it("stops at next ## heading", () => {
    const text = "## Deliverables\n- `file1.js`\n## Other section\n- `file2.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js"]);
  });

  it("parses bullet without backtick using first token", () => {
    const text = "## Deliverables\n- plugins/kusabi/scripts/foo.mjs\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs"]);
  });

  it("strips trailing punctuation from path", () => {
    const text = "## Deliverables\n- `plugins/kusabi/scripts/foo.mjs` — implement the thing\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs"]);
  });

  it("strips variable trailing punctuation characters", () => {
    const text = "## Deliverables\n- `file.js`; also note:\n- `other.py`: the main one\n";
    assert.deepEqual(parseDeliverables(text), ["file.js", "other.py"]);
  });

  it("ignores empty bullet lines but takes first token from non-empty ones", () => {
    const text = "## Deliverables\n- \n- just text without a backtick path\n";
    // First bullet is empty (skipped). Second has first token "just".
    assert.deepEqual(parseDeliverables(text), ["just"]);
  });

  it("handles * bullets", () => {
    const text = "## Deliverables\n* `file1.js`\n* `file2.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.js"]);
  });

  it("handles Deliverables section not at the start of the brief", () => {
    const text = "## Brief\nImplement the thing.\n\n## Deliverables\n- `output.txt`\n";
    assert.deepEqual(parseDeliverables(text), ["output.txt"]);
  });

  it("parses numbered list (1. and 1) syntax)", () => {
    const text = "## Deliverables\n1. `file1.js`\n2) `file2.py`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.py"]);
  });

  it("parses + bullets", () => {
    const text = "## Deliverables\n+ `file.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file.js"]);
  });

  it("parses indented bullets", () => {
    const text = "## Deliverables\n  - `file.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file.js"]);
  });

  it("parses paths from a fenced code block", () => {
    const text = "## Deliverables\n```\nfile1.js\nfile2.py\n```\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.py"]);
  });

  it("parses indented lines inside a fenced code block", () => {
    const text = "## Deliverables\n```\n  file1.js\n\tfile2.py\n```\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.py"]);
  });

  it("a ## line inside a fenced code block does not end the section", () => {
    // Inside a fence every non-blank line is an item, so the `## ` line itself
    // yields a (nonsense) entry — the point is that file2.py after it is still
    // collected rather than being cut off by a spurious section end.
    const text = "## Deliverables\n```\nfile1.js\n## not a heading\nfile2.py\n```\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "##", "file2.py"]);
  });

  it("a fenced code block before the section does not open one", () => {
    const text = "```\n## Deliverables\nnot-a-file.js\n```\n## Deliverables\n- `real.js`\n";
    assert.deepEqual(parseDeliverables(text), ["real.js"]);
  });

  it("strips trailing slashes from declared paths (fixes #79)", () => {
    const text = "## Deliverables\n- `src/`\n";
    assert.deepEqual(parseDeliverables(text), ["src"]);
  });

  it("does not alter paths without trailing slashes", () => {
    const text = "## Deliverables\n- `src`\n";
    assert.deepEqual(parseDeliverables(text), ["src"]);
  });

  it("heading present but nothing parseable yields empty array", () => {
    const text = "## Deliverables\njust prose, no bullet syntax\n";
    assert.deepEqual(parseDeliverables(text), []);
  });

  it("parses paths under an annotated heading (kusabi #167)", () => {
    const text = "## Deliverables (files that must change; notes are NOT deliverables)\n- `plugins/kusabi/scripts/foo.mjs`\n- `docs/DESIGN.md`\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"]);
  });

  it("parses paths under colon and dash annotated headings (kusabi #167)", () => {
    const text = "## Deliverables:\n- `file1.js`\n## Deliverables — required\n- `file2.py`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.py"]);
  });

  it("does not treat word-extension headings as Deliverables (kusabi #167)", () => {
    assert.deepEqual(parseDeliverables("## Deliverables2\n- `file1.js`\n"), []);
    assert.deepEqual(parseDeliverables("## Deliverable\n- `file1.js`\n"), []);
    assert.deepEqual(parseDeliverables("## DeliverablesExtra\n- `file1.js`\n"), []);
  });

  it("annotated heading with nothing parseable yields empty array (kusabi #167)", () => {
    const text = "## Deliverables (notes only)\njust prose, no bullet syntax\n";
    assert.deepEqual(parseDeliverables(text), []);
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => parseDeliverables(null));
    assert.doesNotThrow(() => parseDeliverables(undefined));
    assert.doesNotThrow(() => parseDeliverables(42));
    assert.doesNotThrow(() => parseDeliverables({}));
    assert.doesNotThrow(() => parseDeliverables([]));
  });
});

// parseChangedPaths — git status --porcelain path extraction
// ---------------------------------------------------------------------------

describe("parseChangedPaths", () => {
  it("parses modified paths", () => {
    const output = "M  plugins/kusabi/scripts/foo.mjs\n M docs/DESIGN.md\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"]);
  });

  it("parses untracked files", () => {
    const output = "?? plugins/kusabi/scripts/new-file.mjs\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["plugins/kusabi/scripts/new-file.mjs"]);
  });

  it("parses rename entries (returns both old and new paths)", () => {
    const output = "R  old.js -> new.js\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["old.js", "new.js"]);
  });

  it("returns [] for empty output", () => {
    assert.deepEqual(parseChangedPaths(""), []);
  });

  it("returns [] for null/undefined", () => {
    assert.deepEqual(parseChangedPaths(null), []);
    assert.deepEqual(parseChangedPaths(undefined), []);
  });

  it("handles mixed status entries", () => {
    const output = [
      "M  src/index.js",
      "?? src/new.py",
      "R  old.txt -> renamed.txt",
      "MM src/shared.js",
    ].join("\n");
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["src/index.js", "src/new.py", "old.txt", "renamed.txt", "src/shared.js"]);
  });

  it("strips trailing slash from untracked directory entries", () => {
    assert.deepEqual(parseChangedPaths("?? newdir/\n"), ["newdir"]);
  });

  it("ignores comment lines (starting with #)", () => {
    const output = [
      "# branch.oid abc123",
      "M  src/main.js",
      "# branch.head main",
    ].join("\n");
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["src/main.js"]);
  });
});

// parseSmoke — ## Smoke section parsing
// ---------------------------------------------------------------------------

describe("parseSmoke", () => {
  it("ignores 'exit N' inside the command backticks (annotation must follow the command)", () => {
    const text = "## Smoke\n- `bash -c \"exit 1\"`\n";
    assert.deepEqual(parseSmoke(text), [{ command: 'bash -c "exit 1"', expectedExit: 0 }]);
  });

  it("annotation after the command wins over 'exit N' inside backticks", () => {
    const text = "## Smoke\n- `bash -c \"exit 1\"` — exit 1\n";
    assert.deepEqual(parseSmoke(text), [{ command: 'bash -c "exit 1"', expectedExit: 1 }]);
  });

  it("returns [] for text without ## Smoke section", () => {
    assert.deepEqual(parseSmoke("some brief text\n## Other section\ncontent"), []);
  });

  it("returns [] for empty string", () => {
    assert.deepEqual(parseSmoke(""), []);
  });

  it("returns [] for null/undefined", () => {
    assert.deepEqual(parseSmoke(null), []);
    assert.deepEqual(parseSmoke(undefined), []);
  });

  it("parses backtick-quoted command with default exit 0", () => {
    const text = "## Smoke\n- `node scripts/x.mjs --help`\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "node scripts/x.mjs --help");
    assert.equal(result[0].expectedExit, 0);
  });

  it("parses backtick command with exit 1 annotation", () => {
    const text = "## Smoke\n- `grep -q foo bar` exit 1\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "grep -q foo bar");
    assert.equal(result[0].expectedExit, 1);
  });

  it("parses backtick command with exit annotation after em dash", () => {
    const text = "## Smoke\n- `node scripts/x.mjs --help` — exit 0\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "node scripts/x.mjs --help");
    assert.equal(result[0].expectedExit, 0);
  });

  it("ignores bullet lines without backticks", () => {
    const text = "## Smoke\n- `valid command`\n- just text, no backtick\n- `another valid` exit 2\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].command, "valid command");
    assert.equal(result[0].expectedExit, 0);
    assert.equal(result[1].command, "another valid");
    assert.equal(result[1].expectedExit, 2);
  });

  it("stops at next ## heading", () => {
    const text = "## Smoke\n- `cmd1`\n## Other section\n- `cmd2`\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "cmd1");
  });

  it("parses * bullets", () => {
    const text = "## Smoke\n* `ls -la`\n* `echo hello` exit 1\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].command, "ls -la");
    assert.equal(result[0].expectedExit, 0);
    assert.equal(result[1].command, "echo hello");
    assert.equal(result[1].expectedExit, 1);
  });

  it("handles Smoke section not at the start of the brief", () => {
    const text = "## Brief\nDo stuff.\n\n## Smoke\n- `node test.js` exit 0\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "node test.js");
  });

  it("parses commands from a fenced code block (one per line, exit 0)", () => {
    const text = "## Smoke\n```\nnpm test\necho hello\n```\n";
    const result = parseSmoke(text);
    assert.deepEqual(result, [
      { command: "npm test", expectedExit: 0 },
      { command: "echo hello", expectedExit: 0 },
    ]);
  });

  it("parses indented commands inside a fenced code block", () => {
    const text = "## Smoke\n```\n  npm test\n\techo hello\n```\n";
    assert.deepEqual(parseSmoke(text), [
      { command: "npm test", expectedExit: 0 },
      { command: "echo hello", expectedExit: 0 },
    ]);
  });

  it("a ## line inside a fenced code block does not end the section", () => {
    const text = "## Smoke\n```\nnpm test\n## not a heading\necho hello\n```\n";
    assert.deepEqual(parseSmoke(text), [
      { command: "npm test", expectedExit: 0 },
      { command: "## not a heading", expectedExit: 0 },
      { command: "echo hello", expectedExit: 0 },
    ]);
  });

  it("ignores blank lines inside fenced code block", () => {
    const text = "## Smoke\n```\nnpm test\n\necho hello\n```\n";
    const result = parseSmoke(text);
    assert.deepEqual(result, [
      { command: "npm test", expectedExit: 0 },
      { command: "echo hello", expectedExit: 0 },
    ]);
  });

  it("parses numbered-list smoke entries", () => {
    const text = "## Smoke\n1. `npm test`\n2) `echo hello` exit 1\n";
    const result = parseSmoke(text);
    assert.deepEqual(result, [
      { command: "npm test", expectedExit: 0 },
      { command: "echo hello", expectedExit: 1 },
    ]);
  });

  it("parses + bullet smoke entries", () => {
    const text = "## Smoke\n+ `npm test`\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "npm test");
    assert.equal(result[0].expectedExit, 0);
  });

  it("parses indented bullet smoke entries", () => {
    const text = "## Smoke\n  - `npm test`\n";
    const result = parseSmoke(text);
    assert.equal(result.length, 1);
    assert.equal(result[0].command, "npm test");
  });

  it("heading present but nothing parseable yields empty array", () => {
    const text = "## Smoke\njust prose, no bullet or code block\n";
    assert.deepEqual(parseSmoke(text), []);
  });

  it("parses commands under an annotated heading (kusabi #167)", () => {
    const text = "## Smoke (run in container)\n- `node scripts/x.mjs --help`\n- `npm test` exit 1\n";
    const result = parseSmoke(text);
    assert.deepEqual(result, [
      { command: "node scripts/x.mjs --help", expectedExit: 0 },
      { command: "npm test", expectedExit: 1 },
    ]);
  });

  it("does not treat word-extension headings as Smoke (kusabi #167)", () => {
    assert.deepEqual(parseSmoke("## Smoketest\n- `npm test`\n"), []);
    assert.deepEqual(parseSmoke("## Smoke2\n- `npm test`\n"), []);
  });

  it("annotated heading with nothing parseable yields empty array (kusabi #167)", () => {
    const text = "## Smoke (optional)\njust prose, no bullet or code block\n";
    assert.deepEqual(parseSmoke(text), []);
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => parseSmoke(null));
    assert.doesNotThrow(() => parseSmoke(undefined));
    assert.doesNotThrow(() => parseSmoke(42));
    assert.doesNotThrow(() => parseSmoke({}));
    assert.doesNotThrow(() => parseSmoke([]));
  });
});

// hasSectionHeading — heading-presence detection
// ---------------------------------------------------------------------------

describe("hasSectionHeading", () => {
  it("returns true when heading is present", () => {
    assert.equal(hasSectionHeading("## Deliverables\n- `file.js`\n", "Deliverables"), true);
    assert.equal(hasSectionHeading("some text\n## Smoke\n- `cmd`\n", "Smoke"), true);
  });

  it("returns false when heading is absent", () => {
    assert.equal(hasSectionHeading("no heading here\n", "Deliverables"), false);
    assert.equal(hasSectionHeading("## Other\nstuff\n", "Smoke"), false);
  });

  it("returns false for null/undefined/empty", () => {
    assert.equal(hasSectionHeading(null, "Deliverables"), false);
    assert.equal(hasSectionHeading(undefined, "Smoke"), false);
    assert.equal(hasSectionHeading("", "Deliverables"), false);
  });

  it("returns true even when section body is unparseable prose", () => {
    assert.equal(hasSectionHeading("## Deliverables\njust prose\nno bullets\n", "Deliverables"), true);
    assert.equal(hasSectionHeading("## Smoke\njust prose\n", "Smoke"), true);
  });

  it("returns true for annotated headings (kusabi #167)", () => {
    assert.equal(hasSectionHeading("## Deliverables (files that must change)\n- `file.js`\n", "Deliverables"), true);
    assert.equal(hasSectionHeading("## Deliverables:\n- `file.js`\n", "Deliverables"), true);
    assert.equal(hasSectionHeading("## Smoke (run in container)\n- `npm test`\n", "Smoke"), true);
  });

  it("returns true for annotated heading even with no parseable items (kusabi #167)", () => {
    assert.equal(hasSectionHeading("## Deliverables (notes only)\njust prose\n", "Deliverables"), true);
    assert.equal(hasSectionHeading("## Smoke (optional)\njust prose\n", "Smoke"), true);
  });

  it("returns false for word-extension headings (kusabi #167)", () => {
    assert.equal(hasSectionHeading("## Deliverables2\n- `file.js`\n", "Deliverables"), false);
    assert.equal(hasSectionHeading("## Deliverable\n- `file.js`\n", "Deliverables"), false);
    assert.equal(hasSectionHeading("## Smoketest\n- `npm test`\n", "Smoke"), false);
    assert.equal(hasSectionHeading("## Smoke2\n- `npm test`\n", "Smoke"), false);
  });
});

// briefRequestsPublish — publish-demand detection (kusabi #153)
// ---------------------------------------------------------------------------
// Heuristic contract: a brief that looks like it demands the worker publish
// must be flagged so the chain can warn the orchestrator (publish is
// orchestrator-exclusive; the worker cannot execute it).  Over-detection is
// acceptable — the warning is one line and changes no behaviour.

describe("briefRequestsPublish", () => {
  it("flags a markdown heading that mentions publish", () => {
    assert.equal(briefRequestsPublish("## PUBLISH (mandatory)\n\nDo the work."), true);
    assert.equal(briefRequestsPublish("## Acceptance criteria\n## Publish steps\nfoo"), true);
  });

  it("flags publish near a demand keyword on the same line", () => {
    assert.equal(briefRequestsPublish("PUBLISH (mandatory) after the gate."), true);
    assert.equal(briefRequestsPublish("publish must happen after acceptance."), true);
    assert.equal(briefRequestsPublish("Must publish the changes."), true);
    assert.equal(briefRequestsPublish("publish is required."), true);
    assert.equal(briefRequestsPublish("publish 必須"), true);
    assert.equal(briefRequestsPublish("publish が必要な場合"), true);
    assert.equal(briefRequestsPublish("Do it.\n\nPUBLISH required, then report."), true);
  });

  it("is case-insensitive for both publish and keywords", () => {
    assert.equal(briefRequestsPublish("PUBLISH MANDATORY"), true);
    assert.equal(briefRequestsPublish("Publish Must be done"), true);
  });

  it("does not flag explanatory mentions of publish", () => {
    assert.equal(briefRequestsPublish("publish is orchestrator-exclusive; the worker cannot call it."), false);
    assert.equal(briefRequestsPublish("Do not publish anything."), false);
    assert.equal(briefRequestsPublish("The orchestrator publishes after acceptance."), false);
  });

  it("returns false for briefs without publish", () => {
    assert.equal(briefRequestsPublish("Implement the feature and verify."), false);
    assert.equal(briefRequestsPublish(""), false);
  });

  it("never throws on non-string input", () => {
    assert.equal(briefRequestsPublish(null), false);
    assert.equal(briefRequestsPublish(undefined), false);
    assert.equal(briefRequestsPublish(42), false);
  });
});

