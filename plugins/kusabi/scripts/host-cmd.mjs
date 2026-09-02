// host-cmd: host maintenance command surfaces (kusabi #445).
//
// Extracted from kusabi-companion.mjs:
// - cmdInstallAgents (with copyDirTree, opencodeConfigDir, destDirState)
// - cmdSalvage
//
// IMPORT DIRECTION: Unlike chain-cmd.mjs, chain-ops.mjs, and task-cmd.mjs,
// this module does NOT import kusabi-companion.mjs. It has no cycle with
// companion: it calls only leaf modules (cli.mjs, render.mjs, state-paths.mjs,
// job-store.mjs, prompt-execution.mjs).
//
// This module does NOT import chain-driver.mjs, chain-cmd.mjs, chain-ops.mjs,
// task-cmd.mjs, metrics-cmd.mjs, chain-phases.mjs, or chain-review.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseModel } from "./cli.mjs";
import { renderHeader } from "./render.mjs";
import { stateDirFor } from "./state-paths.mjs";
import { jobDir, saveJob, loadJob } from "./job-store.mjs";
import { runPrompt } from "./prompt-execution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// Copy a directory tree recursively. Used for skills, which are shipped as a
// whole directory (SKILL.md plus any assets) and must keep their directory name.
function copyDirTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirTree(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// opencode's real config dir, which is where it discovers agents and skills.
// It is relocatable via XDG_CONFIG_HOME, so the install defaults below must
// track it -- otherwise "the default destination is a discovery path" stops
// being true on exactly the hosts that relocated it. Single place to extend
// if opencode grows another relocation knob.
function opencodeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

// Classify an install destination. Two views of the same path are needed: the
// link itself (lstat) and whatever it resolves to (stat). A dangling symlink
// exists as a path but has no target, so stat throws while lstat succeeds --
// reading that as "absent" is exactly what lets a later mkdirSync die
// mid-install, after the agents were already written.
function destDirState(p) {
  try {
    fs.lstatSync(p);
  } catch {
    return "absent";
  }
  let real = null;
  try {
    real = fs.statSync(p);
  } catch {
    return "broken-symlink";
  }
  return real.isDirectory() ? "directory" : "not-a-directory";
}

export function cmdInstallAgents() {
  const src = path.join(PLUGIN_ROOT, "opencode-agents");
  const dest = process.env.OPENCODE_AGENT_DIR || path.join(opencodeConfigDir(), "agent");

  // Skills destination preflight — runs BEFORE any mutation, so a broken
  // skills destination fails the whole command cleanly instead of leaving
  // the agent half installed and then dying on a raw mkdirSync EEXIST.
  // (OPENCODE_SKILL_DIR / OPENCODE_AGENT_DIR are placement overrides that
  // opencode 1.18.15 does not read; see the skills comment below.)
  const skillSrc = path.join(PLUGIN_ROOT, "opencode-skills");
  const skillDest = process.env.OPENCODE_SKILL_DIR || path.join(opencodeConfigDir(), "skills");
  const skillDestState = destDirState(skillDest);
  if (skillDestState !== "absent" && skillDestState !== "directory") {
    throw new Error(
      `skills destination ${skillDest} is not a usable directory (${skillDestState}); refusing to install skills`,
    );
  }

  fs.mkdirSync(dest, { recursive: true });
  // Remove stale legacy agent definitions from install target
  const stale = ["oc-draft.md", "oc-investigate.md", "oc-implement.md", "oc-review.md", "oc-respond.md", "oc-salvage.md"];
  let removed = 0;
  for (const f of stale) {
    const target = path.join(dest, f);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed += 1;
    }
  }
  // Install current agent definitions under new kusabi-* names
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));

  // Skills distribution: copy-and-overwrite ONLY — never delete anything at
  // the destination. The skills dir (OPENCODE_SKILL_DIR, default
  // ~/.config/opencode/skills) is shared with skills the user installed
  // themselves, and there is no kusabi-owned name registry that would make
  // deletion safe. (Contrast the agent path above, which deletes a fixed,
  // explicit list of legacy oc-* names — no such list exists for skills.)
  // Do not "clean this up" into a prune step.
  //
  // Note on OPENCODE_SKILL_DIR (and OPENCODE_AGENT_DIR, same status): these
  // are PLACEMENT overrides honoured by install-agents; opencode 1.18.15 does
  // not read either env var — it discovers skills/agents under its own config
  // dir. The default destination therefore has to be that dir, which is why it
  // is derived from opencodeConfigDir() (XDG_CONFIG_HOME aware) rather than
  // hardcoding ~/.config. Setting OPENCODE_SKILL_DIR to anything else lands
  // outside opencode's scan and must not be reported as discovered.
  fs.mkdirSync(skillDest, { recursive: true });

  const skillDirs = fs.existsSync(skillSrc)
    ? fs.readdirSync(skillSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  // Per-skill preflight: the destination is user-controlled and never pruned,
  // so a name collision with a non-directory (a file, or a symlink that does
  // not resolve to a directory) must not crash the install — skip that skill
  // with a warning, leave the colliding path untouched (no-delete), and
  // continue with the rest.
  const skipped = [];
  for (const dir of skillDirs) {
    const destDir = path.join(skillDest, dir);
    const state = destDirState(destDir);
    if (state !== "absent" && state !== "directory") {
      skipped.push(`${dir} (${state})`);
      continue;
    }
    copyDirTree(path.join(skillSrc, dir), destDir);
  }
  let message = `installed ${files.length} phase agents to ${dest} (removed ${removed} stale legacy names); ` +
    `installed ${skillDirs.length - skipped.length} skills to ${skillDest}`;
  if (skipped.length > 0) {
    message += `; skipped ${skipped.length} skill(s): ${skipped.join(", ")} (destination exists and is not a directory — left untouched)`;
  }
  return message;
}

export async function cmdSalvage(cwd, { flags, text }) {
  const deadJobId = text.split(/\s+/).filter(Boolean)[0];
  if (!deadJobId) throw new Error("salvage requires a dead job ID");
  const stateDir = stateDirFor(cwd);
  const deadJob = loadJob(stateDir, deadJobId);
  if (!deadJob) throw new Error(`no such job: ${deadJobId}`);

  // read dead job artifacts
  const deadDir = jobDir(stateDir, deadJobId);
  const originalBrief = fs.readFileSync(path.join(deadDir, "prompt.md"), "utf8");
  const eventsRaw = fs.readFileSync(path.join(deadDir, "events.ndjson"), "utf8")
    .split("\n").filter(Boolean).slice(-50)
    .map((l) => JSON.parse(l));

  // build salvage prompt
  const promptText = [
    `## Dead job info`,
    `- job ID: ${deadJob.id}`,
    `- kind: ${deadJob.kind}`,
    `- phase: ${deadJob.phase ?? "(none)"}`,
    `- status: ${deadJob.status}`,
    `- error: ${deadJob.error ?? "(none)"}`,
    `- models used: ${(deadJob.stats?.models ?? []).join(", ") || "(none)"}`,
    `- container ID: ${flags.container ?? "(not provided)"}`,
    `- Original brief:`,
    originalBrief,
    `## Recent events (${eventsRaw.length} items)`,
    eventsRaw.map((e) => JSON.stringify(e)).join("\n"),
  ].join("\n\n");

  const { job, resultText } = await runPrompt({
    cwd,
    kind: "salvage",
    title: `salvage: ${deadJobId}`,
    promptText,
    agent: "kusabi-salvage",
    phase: "salvage",
    model: parseModel(flags.model),
    tools: Object.fromEntries(
      ["bash", "edit", "write", "patch", "task", "skill"].map((t) => [t, false])
    ),
    timeoutS: Number(flags.timeout ?? 600),
    watchdogS: 0,
  });

  // record salvagedFrom
  job.salvagedFrom = deadJobId;
  saveJob(stateDir, job);

  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}`;
  }
  return `${renderHeader(job)}${resultText || "(empty report)"}`;
}
