#!/usr/bin/env node
/** One-time offline migration. Stop Bossmode before --apply. Sources are never deleted. */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const dryRun = argv.includes("--dry-run");
const apply = argv.includes("--apply");
const rootArgument = option("--bossmode-dir");
const outputFile = option("--output");
if (dryRun === apply || !rootArgument || !isAbsolute(rootArgument)) {
  console.error("Use exactly one of --dry-run or --apply with --bossmode-dir <absolute stopped-service directory> [--output report.ndjson]");
  process.exit(1);
}
let root;
try { root = await realpath(rootArgument); }
catch { console.error("bossmode directory does not exist"); process.exit(1); }

const report = [];
const emit = (record) => report.push(record);
const stats = { planned: 0, conflicts: 0, errors: 0, skippedIdentical: 0, writes: 0 };
const referenced = new Set();
const plans = [];
const memberIds = new Set(existsSync(join(root, "members"))
  ? (await readdir(join(root, "members"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : []);
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function conflict(source, reason, detail) {
  stats.conflicts++;
  emit({ kind: "conflict", source, reason, detail, status: "manual-required" });
}
function error(source, reason, detail) {
  stats.errors++;
  emit({ kind: "error", source, reason, detail });
}
async function walk(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}
function readHeader(file) {
  const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
  const header = JSON.parse(firstLine);
  if (header?.type !== "session" || !header.id || !header.timestamp || Number.isNaN(Date.parse(header.timestamp))) {
    throw new Error("missing valid SDK session header id/timestamp");
  }
  return header;
}

emit({
  kind: "header", format: "member-session-migration/v1", mode: dryRun ? "dry-run" : "apply",
  writes: apply, generatedAt: new Date().toISOString(), serviceRequirement: "stopped",
});
for (const referenceFile of await walk(join(root, "rooms"))) {
  if (!referenceFile.endsWith("/sessions.json")) continue;
  let references;
  try { references = JSON.parse(readFileSync(referenceFile, "utf8")); }
  catch (cause) { error(referenceFile, "invalid-reference-json", String(cause)); continue; }
  const parts = relative(root, referenceFile).split("/");
  const roomId = parts[1];
  const topicIndex = parts.indexOf("topics");
  const topicId = topicIndex >= 0 ? parts[topicIndex + 1] : null;
  const scopeId = topicId ? `topic:${topicId}` : `room:${roomId}`;
  const targetScope = topicId ? join("topics", topicId) : join("rooms", roomId);
  for (const [memberId, sessionValue] of Object.entries(references || {})) {
    const session = sessionValue || {};
    if (session.sessionFile) referenced.add(resolve(session.sessionFile));
    if (!memberIds.has(memberId)) { conflict(referenceFile, "unresolved-owner", { scopeId, memberKey: memberId }); continue; }
    if (!session.sessionFile || !existsSync(session.sessionFile)) {
      conflict(session.sessionFile || referenceFile, "missing-session-file", { scopeId, memberId, sessionId: session.sessionId });
      continue;
    }
    let header;
    try { header = readHeader(session.sessionFile); }
    catch (cause) { conflict(session.sessionFile, "missing-header-date", { scopeId, memberId, detail: String(cause) }); continue; }
    const day = new Date(header.timestamp).toISOString().slice(0, 10);
    const targetRelative = join("members", memberId, "sessions", day, targetScope, session.sessionFile.split("/").at(-1));
    const target = join(root, targetRelative);
    const sourceHash = sha256(session.sessionFile);
    const targetState = existsSync(target) ? (sha256(target) === sourceHash ? "identical" : "different") : "absent";
    if (targetState === "different") { conflict(target, "target-exists-different-content", { source: session.sessionFile, scopeId, memberId }); continue; }
    if (targetState === "identical") stats.skippedIdentical++;
    const newSession = { ...session, sessionId: session.sessionId || header.id, sessionFile: relative(join(root, "members", memberId), target) };
    const plan = { source: session.sessionFile, target, targetRelative, memberId, scopeId, sessionId: newSession.sessionId, size: statSync(session.sessionFile).size, sha256: sourceHash, targetState, newSession };
    plans.push(plan);
    stats.planned++;
    emit({ kind: "plan", ...plan, referenceChange: {
      scopeId,
      from: { file: referenceFile, memberKey: memberId, session },
      to: { file: join("members", memberId, "sessions", "current.json"), memberKey: scopeId, session: newSession },
    }, status: targetState === "identical" ? "already-copied" : "ready" });
  }
}
for (const file of await walk(root)) {
  if (!file.endsWith(".jsonl") || file.includes("/members/") || referenced.has(resolve(file))) continue;
  conflict(file, "unresolved-owner", { detail: "no authoritative room/topic/current reference" });
}

const recovery = { sourceFilesDeleted: false, oldReferencesModified: false, currentBackups: [], copiedTargets: [] };
if (apply && stats.errors === 0 && stats.conflicts === 0) {
  const staged = [];
  const currentBackups = new Map();
  try {
    for (const plan of plans) {
      if (plan.targetState === "identical") continue;
      mkdirSync(dirname(plan.target), { recursive: true });
      const temp = `${plan.target}.${process.pid}.migration.tmp`;
      copyFileSync(plan.source, temp);
      if (sha256(temp) !== plan.sha256) throw new Error(`hash mismatch after copy: ${plan.source}`);
      staged.push({ temp, target: plan.target });
    }
    const byMember = new Map();
    for (const plan of plans) {
      const current = byMember.get(plan.memberId) || {};
      current[plan.scopeId] = plan.newSession;
      byMember.set(plan.memberId, current);
    }
    for (const [memberId, additions] of byMember) {
      const path = join(root, "members", memberId, "sessions", "current.json");
      let original = null;
      if (existsSync(path)) {
        original = readFileSync(path);
        const parsed = JSON.parse(original.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid current.json: ${path}`);
      }
      currentBackups.set(path, original);
      recovery.currentBackups.push({ path, existed: original !== null });
      const merged = { ...(original ? JSON.parse(original.toString("utf8")) : {}), ...additions };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.${process.pid}.migration.tmp`, JSON.stringify(merged, null, 2) + "\n");
    }
    for (const item of staged) { renameSync(item.temp, item.target); recovery.copiedTargets.push(item.target); stats.writes++; }
    for (const path of currentBackups.keys()) { renameSync(`${path}.${process.pid}.migration.tmp`, path); stats.writes++; }
  } catch (cause) {
    error(root, "apply-failed", String(cause));
    for (const item of staged) rmSync(item.temp, { force: true });
    for (const [path, original] of currentBackups) {
      rmSync(`${path}.${process.pid}.migration.tmp`, { force: true });
      if (original === null) rmSync(path, { force: true });
      else writeFileSync(path, original);
    }
    emit({ kind: "recovery", status: "references-restored", ...recovery });
  }
} else if (apply && (stats.errors || stats.conflicts)) {
  emit({ kind: "apply-blocked", reason: "resolve every conflict/error before retry", writes: 0 });
}
const exitCode = stats.errors ? 1 : stats.conflicts ? 2 : 0;
emit({ kind: "summary", ...stats, exitCode, recovery });
const text = report.map((record) => JSON.stringify(record)).join("\n") + "\n";
if (outputFile) writeFileSync(outputFile, text);
else process.stdout.write(text);
process.exitCode = exitCode;
