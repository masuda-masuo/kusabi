import fs from "node:fs";

export function loggedArgs(argsLog) {
  const text = fs.readFileSync(argsLog, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l)) : [];
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0); // throws if the pid is gone (or EPERM = alive)
    // kill(pid, 0) succeeds for zombies too, so read the state directly:
    // after the group kill the orphaned grandchild is reparented to init
    // and may sit unreaped as a zombie (state Z/X) for a moment — it IS
    // dead, and the dispatch's 'close' already proves the pipe holders
    // exited, so a lingering zombie must not fail the assertion.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
