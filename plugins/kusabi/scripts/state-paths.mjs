// state-paths.mjs — state directory layout and JSON file helpers
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import process from "node:process";

export function stateRoot(homeDir) {
  const envDir = process.env.KUSABI_STATE_DIR || process.env.OPENCODE_COMPANION_STATE_DIR;
  if (envDir) return envDir;
  const home = homeDir ?? os.homedir();
  const newDir = path.join(home, ".kusabi");
  const oldDir = path.join(home, ".opencode-plugin-cc");
  // One-time migration: rename old state dir to new name if only the old exists.
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try { fs.renameSync(oldDir, newDir); } catch { /* best-effort */ }
  }
  return newDir;
}

export function stateDirFor(cwd) {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = path.join(stateRoot(), hash);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replace: write to a unique temp file in the SAME directory, then
  // rename over the target.  A reader can otherwise catch a partially written
  // target (a torn job.json rewrite mid stats-update used to make task-wait
  // call a healthy running task "stalled").  rename(2) on the same
  // filesystem is atomic, so the target is always the old or the new full
  // content, never a mix.
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort: temp may not exist */ }
    throw err;
  }
}
