// job-store.mjs — on-disk job record persistence
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { readJson, writeJson } from "./state-paths.mjs";

export function newJobId() {
  return `job-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

export function jobDir(stateDir, jobId) {
  return path.join(stateDir, "jobs", jobId);
}

export function saveJob(stateDir, job) {
  writeJson(path.join(jobDir(stateDir, job.id), "job.json"), job);
}

export function loadJob(stateDir, jobId) {
  return readJson(path.join(jobDir(stateDir, jobId), "job.json"));
}

export function listJobs(stateDir) {
  const root = path.join(stateDir, "jobs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => loadJob(stateDir, id))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

export function latestJob(stateDir, predicate = () => true) {
  return listJobs(stateDir).find(predicate) ?? null;
}

export function appendEvent(stateDir, jobId, event) {
  fs.appendFileSync(path.join(jobDir(stateDir, jobId), "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}
