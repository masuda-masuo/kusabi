// review-record-archive.mjs — stage a chain review record in a local kairanban clone.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chainStateDirFor, stateRoot } from "./state-paths.mjs";
import { unfilledAdjudicationLines } from "./review-record-table.mjs";

export const USAGE = "Usage: review-record-archive <chainId> --kairanban <path> [--force] [--state-root <dir>]";

function parseArgs(argv) {
  let chainId = null;
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      if (options.force) throw new Error("duplicate flag: --force");
      options.force = true;
    } else if (arg === "--kairanban" || arg === "--state-root") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      const key = arg === "--kairanban" ? "kairanbanDir" : "stateRootDir";
      if (options[key] !== undefined) throw new Error(`duplicate flag: ${arg}`);
      options[key] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (chainId === null) {
      chainId = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!chainId) throw new Error(USAGE);
  if (!/^chain-[a-z0-9]+$/.test(chainId)) throw new Error(`invalid chain id: ${chainId}`);
  if (!options.kairanbanDir) throw new Error("--kairanban is required");
  return { chainId, ...options };
}

function repoNameFrom(repo) {
  if (typeof repo !== "string") return null;
  const match = repo.match(/^[^/]+\/([^/]+)$/);
  if (!match) throw new Error(`invalid repository identity in chain.json: ${repo}`);
  return match[1];
}

function validatePathSegment(value, label) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9._-]+$/.test(value)
    || value.includes("..")
    || value.startsWith(".")
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function unfilledRows(content) {
  const result = unfilledAdjudicationLines(content);
  if (!result.sectionFound) throw new Error("review record is missing the findings adjudication heading");
  return result.unfilled.map(({ row }) => row);
}

function writeArchiveFiles(targets) {
  const staged = targets.map(({ filePath, content }) => ({
    filePath,
    content,
    existed: fs.existsSync(filePath),
    temporaryPath: path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    ),
    renamed: false,
  }));

  try {
    for (const target of staged) {
      fs.writeFileSync(target.temporaryPath, target.content, { flag: "wx" });
    }
    for (const target of staged) {
      fs.renameSync(target.temporaryPath, target.filePath);
      target.renamed = true;
    }
  } catch (error) {
    for (const target of staged) {
      try { fs.unlinkSync(target.temporaryPath); } catch { /* best-effort cleanup */ }
    }
    for (const target of staged) {
      if (target.renamed && !target.existed) {
        try { fs.unlinkSync(target.filePath); } catch { /* best-effort cleanup */ }
      }
    }
    throw error;
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function archiveReviewRecord({ chainId, kairanbanDir, force = false, stateRootDir = stateRoot(), cwd = process.cwd() }) {
  if (!/^chain-[a-z0-9]+$/.test(chainId ?? "")) throw new Error(`invalid chain id: ${chainId}`);
  if (typeof kairanbanDir !== "string" || !fs.existsSync(kairanbanDir) || !fs.statSync(kairanbanDir).isDirectory()) {
    throw new Error(`kairanban clone not found: ${kairanbanDir}`);
  }
  const gitPath = path.join(kairanbanDir, ".git");
  if (!fs.existsSync(gitPath)) throw new Error(`not a git clone (missing .git): ${kairanbanDir}`);

  const chainDir = chainStateDirFor(chainId, cwd, stateRootDir);
  const chainJsonPath = path.join(chainDir, "chain.json");
  let chain;
  try {
    chain = JSON.parse(fs.readFileSync(chainJsonPath, "utf8"));
  } catch {
    throw new Error(`chain.json not found or invalid for chain ${chainId}`);
  }
  const recordPath = path.join(chainDir, "review-record.md");
  if (!fs.existsSync(recordPath)) throw new Error(`review record not found for chain ${chainId}`);
  const record = fs.readFileSync(recordPath);
  const rows = unfilledRows(record.toString("utf8"));
  if (rows.length > 0) throw new Error(`review record has unfilled rows: ${rows.join(", ")}`);

  let repoName = repoNameFrom(chain.repo);
  let fallbackMessage = "";
  if (repoName === null) {
    repoName = path.basename(cwd);
    fallbackMessage = `repo was not in chain.json; using label ${repoName}`;
  }
  validatePathSegment(repoName, "repo name");
  validatePathSegment(chainId, "chain id");

  if (typeof chain.brief !== "string") throw new Error(`chain.json brief is missing for chain ${chainId}`);
  const brief = Buffer.from(chain.brief.replace(/(?:\r?\n)*$/, "") + "\n", "utf8");
  const targetRelative = path.join("records", repoName, chainId);
  const targetDir = path.join(kairanbanDir, targetRelative);
  const targets = [
    { name: "review-record.md", content: record },
    { name: "brief.md", content: brief },
  ];
  let unchanged = true;
  for (const target of targets) {
    const targetPath = path.join(targetDir, target.name);
    if (!fs.existsSync(targetPath)) {
      unchanged = false;
      continue;
    }
    const current = fs.readFileSync(targetPath);
    if (!current.equals(target.content)) {
      unchanged = false;
      if (!force) throw new Error(`target differs: ${path.join(targetRelative, target.name)} (pass --force to overwrite)`);
    }
  }
  if (!unchanged) {
    fs.mkdirSync(targetDir, { recursive: true });
    writeArchiveFiles(targets.map((target) => ({
      filePath: path.join(targetDir, target.name),
      content: target.content,
    })));
  }

  const commands = `git -C ${shellQuote(path.resolve(kairanbanDir))} add ${targetRelative} && git -C ${shellQuote(path.resolve(kairanbanDir))} commit -m "Archive review record for ${repoName} ${chainId}" && git -C ${shellQuote(path.resolve(kairanbanDir))} push`;
  return [
    ...(fallbackMessage ? [fallbackMessage] : []),
    unchanged ? "unchanged" : `wrote ${path.join(targetRelative, "review-record.md")} and ${path.join(targetRelative, "brief.md")}`,
    commands,
  ].join("\n");
}

export function cmdReviewRecordArchive(argv, { cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  const stateRootDir = options.stateRootDir ?? stateRoot();
  return archiveReviewRecord({ ...options, stateRootDir, cwd });
}
