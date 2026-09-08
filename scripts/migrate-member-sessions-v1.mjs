#!/usr/bin/env node
/** One-time offline migration. Stop Bossmode before --apply. Sources are never deleted. */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const dryRun = argv.includes("--dry-run");
const apply = argv.includes("--apply");
const recover = argv.includes("--recover");
const rootArgument = option("--bossmode-dir");
const outputFile = option("--output");
const injectedFailure = process.env.BOSSMODE_MIGRATION_TEST_FAIL_AT;
if ([dryRun, apply, recover].filter(Boolean).length !== 1 || !rootArgument || !isAbsolute(rootArgument)) {
  console.error("Use exactly one of --dry-run, --apply, or --recover with --bossmode-dir <absolute stopped-service directory> [--output report.ndjson]");
  process.exit(1);
}
let root;
try { root = await realpath(rootArgument); }
catch { console.error("bossmode directory does not exist"); process.exit(1); }

const recoveryPath = join(root, "migrations", "member-sessions-v1-recovery.json");
const report = [];
const emit = (record) => report.push(record);
const stats = { planned: 0, conflicts: 0, errors: 0, skippedIdentical: 0, writes: 0 };
const referenced = new Set();
const plans = [];
const seenSessionIds = new Map();
const seenSources = new Map();
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
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (cause) { error(directory, "directory-read-failed", String(cause)); return result; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}
function checkDuplicate(source, sessionId, sourceHash, scopeId) {
  const absolute = resolve(source);
  const previousSource = seenSources.get(absolute);
  if (previousSource && previousSource !== scopeId) {
    conflict(source, "duplicate-source", { scopes: [previousSource, scopeId] });
    return false;
  }
  seenSources.set(absolute, scopeId);
  const previous = seenSessionIds.get(sessionId);
  if (previous && previous.sha256 !== sourceHash) {
    conflict(source, "duplicate-session-id-different-sha256", { sessionId, previousSource: previous.source, previousSha256: previous.sha256, sha256: sourceHash });
    return false;
  }
  seenSessionIds.set(sessionId, { source, sha256: sourceHash });
  return true;
}
function validateLegacySource(file, expectedSessionRoot) {
  const absolute = resolve(file);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error("legacy session source may not be a symlink");
  const real = realpathSync(absolute);
  const expected = realpathSync(expectedSessionRoot);
  if (!real.startsWith(expected + "/")) throw new Error("legacy session source is outside its known scope session root");
  return real;
}
function validateTarget(target, memberId) {
  const memberRoot = realpathSync(join(root, "members", memberId));
  const rel = relative(memberRoot, resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("target escapes member directory");
  let cursor = memberRoot;
  for (const part of rel.split("/").slice(0, -1)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`target ancestor is symlink: ${cursor}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`target is symlink: ${target}`);
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
  kind: "header", format: "member-session-migration/v1", mode: dryRun ? "dry-run" : apply ? "apply" : "recover",
  writes: apply || recover, generatedAt: new Date().toISOString(), serviceRequirement: "stopped",
});
function finish(exitCode, extra = {}) {
  emit({ kind: "summary", ...stats, ...extra, exitCode });
  const text = report.map((record) => JSON.stringify(record)).join("\n") + "\n";
  if (outputFile) writeFileSync(outputFile, text); else process.stdout.write(text);
  process.exit(exitCode);
}
function parseRecovery() {
  if (lstatSync(recoveryPath).isSymbolicLink()) throw new Error("recovery material may not be a symlink");
  const material = JSON.parse(readFileSync(recoveryPath, "utf8"));
  if (material?.format !== "member-session-recovery/v1"
      || !["prepared", "recovering", "complete", "recovered"].includes(material.state)
      || !Array.isArray(material.currentBackups)) throw new Error("invalid recovery format/state");
  return material;
}
function writeRecovery(material) {
  const migrationDir = dirname(recoveryPath);
  if (existsSync(migrationDir) && lstatSync(migrationDir).isSymbolicLink()) throw new Error("migration directory may not be a symlink");
  mkdirSync(migrationDir, { recursive: true });
  if (realpathSync(migrationDir) !== migrationDir) throw new Error("migration directory escapes bossmode root");
  const temp = `${recoveryPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(material, null, 2) + "\n");
  renameSync(temp, recoveryPath);
}
function validateRecoveryItem(item) {
  if (!item || typeof item.path !== "string" || typeof item.publishedSha256 !== "string"
      || !(typeof item.originalBase64 === "string" || item.originalBase64 === null)) {
    throw new Error("invalid recovery item");
  }
  if (typeof item.memberId !== "string" || !memberIds.has(item.memberId)) throw new Error("recovery item has unknown memberId");
  const expected = join(root, "members", item.memberId, "sessions", "current.json");
  if (resolve(item.path) !== expected) throw new Error(`recovery path does not belong to member ${item.memberId}: ${item.path}`);
  const memberRoot = realpathSync(join(root, "members", item.memberId));
  if (!memberRoot.startsWith(root + "/members/")) throw new Error(`member directory escapes root: ${item.memberId}`);
  const sessionsDir = dirname(item.path);
  if (lstatSync(sessionsDir).isSymbolicLink() || realpathSync(sessionsDir) !== join(memberRoot, "sessions")) throw new Error(`recovery sessions path escapes member: ${item.path}`);
  if (existsSync(item.path) && lstatSync(item.path).isSymbolicLink()) throw new Error(`recovery current path is symlink: ${item.path}`);
}
function restoreOriginalCurrent(item) {
  if (item.originalBase64 === null) { rmSync(item.path, { force: true }); return; }
  const temp = `${item.path}.${process.pid}.recover.tmp`;
  writeFileSync(temp, Buffer.from(item.originalBase64, "base64"));
  renameSync(temp, item.path);
}
if (recover) {
  if (!existsSync(recoveryPath)) error(recoveryPath, "recovery-material-missing", "run --apply first");
  else {
    try {
      const material = parseRecovery();
      for (const item of material.currentBackups) validateRecoveryItem(item);
      material.state = "recovering";
      writeRecovery(material);
      let restored = 0;
      for (const item of material.currentBackups) {
        const currentHash = existsSync(item.path) ? sha256(item.path) : null;
        const original = item.originalBase64 === null ? null : Buffer.from(item.originalBase64, "base64");
        const originalHash = original === null ? null : createHash("sha256").update(original).digest("hex");
        if (currentHash === originalHash) {
          emit({ kind: "recovered", path: item.path, status: "already-original" });
        } else if (currentHash === item.publishedSha256) {
          restoreOriginalCurrent(item);
          stats.writes++;
          emit({ kind: "recovered", path: item.path, status: "original-current-restored" });
        } else {
          conflict(item.path, "recovery-current-changed", { expectedPublishedSha256: item.publishedSha256, originalSha256: originalHash, currentSha256: currentHash });
        }
        restored++;
        if (injectedFailure === "after-first-recovery-item" && restored === 1) process.exit(87);
      }
      if (!stats.conflicts && !stats.errors) {
        material.state = "recovered";
        material.recoveredAt = new Date().toISOString();
        writeRecovery(material);
        stats.writes++;
      }
    } catch (cause) { error(recoveryPath, "recovery-failed", String(cause)); }
  }
  finish(stats.errors ? 1 : stats.conflicts ? 2 : 0);
}
if (apply && existsSync(recoveryPath)) {
  try {
    const material = parseRecovery();
    if (material.state === "prepared" || material.state === "recovering") {
      conflict(recoveryPath, "unfinished-recovery", { state: material.state, requiredAction: "run --recover before any apply" });
      finish(2);
    }
    if (material.state === "complete") {
      emit({ kind: "apply-skipped", reason: "migration-already-settled", recoveryState: material.state });
      finish(0);
    }
    const historyDir = join(root, "migrations", "member-sessions-v1-history");
    if (existsSync(historyDir) && lstatSync(historyDir).isSymbolicLink()) throw new Error("recovery history directory may not be a symlink");
    mkdirSync(historyDir, { recursive: true });
    if (realpathSync(historyDir) !== historyDir) throw new Error("recovery history directory escapes bossmode root");
    const materialBytes = readFileSync(recoveryPath);
    const materialHash = createHash("sha256").update(materialBytes).digest("hex");
    const historyPath = join(historyDir, `${String(material.recoveredAt || material.generatedAt).replace(/[^0-9A-Za-z.-]/g, "_")}-${materialHash.slice(0, 16)}.json`);
    if (existsSync(historyPath)) {
      if (sha256(historyPath) !== materialHash) throw new Error(`recovery history conflict: ${historyPath}`);
      rmSync(recoveryPath);
    } else renameSync(recoveryPath, historyPath);
    stats.writes++;
    emit({ kind: "recovery-archived", source: recoveryPath, historyPath, sha256: materialHash, priorState: material.state });
  } catch (cause) {
    error(recoveryPath, "invalid-recovery-material", String(cause));
    finish(1);
  }
}

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
    const expectedSourceRoot = topicId
      ? join(root, "rooms", roomId, "topics", topicId, "sessions")
      : join(root, "pi-agent", "runtime", roomId, memberId, "sessions");
    try { validateLegacySource(session.sessionFile, expectedSourceRoot); header = readHeader(session.sessionFile); }
    catch (cause) { conflict(session.sessionFile, "invalid-session-source", { scopeId, memberId, detail: String(cause) }); continue; }
    if (session.sessionId && session.sessionId !== header.id) {
      conflict(session.sessionFile, "session-id-header-mismatch", { scopeId, memberId, referenceSessionId: session.sessionId, headerSessionId: header.id });
      continue;
    }
    const day = new Date(header.timestamp).toISOString().slice(0, 10);
    const targetRelative = join("members", memberId, "sessions", day, targetScope, session.sessionFile.split("/").at(-1));
    const target = join(root, targetRelative);
    let sourceHash;
    let targetState;
    let sourceSize;
    try {
      validateTarget(target, memberId);
      sourceHash = sha256(session.sessionFile);
      sourceSize = statSync(session.sessionFile).size;
      targetState = existsSync(target) ? (sha256(target) === sourceHash ? "identical" : "different") : "absent";
    } catch (cause) { error(session.sessionFile, "session-read-failed", String(cause)); continue; }
    const sessionId = session.sessionId || header.id;
    if (!checkDuplicate(session.sessionFile, sessionId, sourceHash, scopeId)) continue;
    if (targetState === "different") { conflict(target, "target-exists-different-content", { source: session.sessionFile, scopeId, memberId }); continue; }
    if (targetState === "identical") stats.skippedIdentical++;
    const newSession = { ...session, sessionId, sessionFile: relative(join(root, "members", memberId), target) };
    const currentPath = join(root, "members", memberId, "sessions", "current.json");
    if (existsSync(currentPath)) {
      try {
        const current = JSON.parse(readFileSync(currentPath, "utf8"));
        const existing = current?.[scopeId];
        if (existing && (existing.sessionId !== newSession.sessionId || existing.sessionFile !== newSession.sessionFile)) {
          conflict(currentPath, "current-session-changed", { scopeId, existing, migrationReference: newSession });
          continue;
        }
      } catch (cause) { error(currentPath, "invalid-current-json", String(cause)); continue; }
    }
    const plan = { source: session.sessionFile, target, targetRelative, memberId, scopeId, sessionId, size: sourceSize, sha256: sourceHash, targetState, newSession, publishCurrent: true };
    plans.push(plan);
    stats.planned++;
    emit({ kind: "plan", ...plan, referenceChange: {
      scopeId,
      from: { file: referenceFile, memberKey: memberId, session },
      to: { file: join("members", memberId, "sessions", "current.json"), memberKey: scopeId, session: newSession },
    }, status: targetState === "identical" ? "already-copied" : "ready" });
  }
}
// Legacy DM sessions lived under members/<id>/dm/sessions without a current reference.
// Their member/scope is known from the directory, but no file is guessed as current.
for (const memberId of memberIds) {
  for (const source of await walk(join(root, "pi-agent", "runtime", "members", memberId, "dm", "sessions"))) {
    if (!source.endsWith(".jsonl")) continue;
    referenced.add(resolve(source));
    let header;
    let sourceHash;
    try { validateLegacySource(source, join(root, "pi-agent", "runtime", "members", memberId, "dm", "sessions")); header = readHeader(source); sourceHash = sha256(source); }
    catch (cause) { error(source, "dm-session-read-failed", String(cause)); continue; }
    if (!checkDuplicate(source, header.id, sourceHash, `dm:${memberId}`)) continue;
    const day = new Date(header.timestamp).toISOString().slice(0, 10);
    const targetRelative = join("members", memberId, "sessions", day, "dm", source.split("/").at(-1));
    const target = join(root, targetRelative);
    let targetState;
    let sourceSize;
    try {
      validateTarget(target, memberId);
      sourceSize = statSync(source).size;
      targetState = existsSync(target) ? (sha256(target) === sourceHash ? "identical" : "different") : "absent";
    } catch (cause) { error(source, "dm-session-target-read-failed", String(cause)); continue; }
    if (targetState === "different") { conflict(target, "target-exists-different-content", { source, scopeId: `dm:${memberId}`, memberId }); continue; }
    if (targetState === "identical") stats.skippedIdentical++;
    const plan = { source, target, targetRelative, memberId, scopeId: `dm:${memberId}`, sessionId: header.id, size: sourceSize, sha256: sourceHash, targetState, publishCurrent: false };
    plans.push(plan);
    stats.planned++;
    emit({ kind: "plan", ...plan, referenceChange: null, status: targetState === "identical" ? "already-copied" : "ready", currentStatus: "historical-only-no-legacy-current-reference" });
  }
}
// Reset room histories have no current reference, but their runtime path carries a known room/member mapping.
const runtimeRoot = join(root, "pi-agent", "runtime");
for (const source of await walk(runtimeRoot)) {
  if (!source.endsWith(".jsonl") || referenced.has(resolve(source))) continue;
  const match = /^([^/]+)\/([^/]+)\/sessions\/(.+\.jsonl)$/.exec(relative(runtimeRoot, source).split("\\").join("/"));
  if (!match || match[1] === "members" || !memberIds.has(match[2]) || !existsSync(join(root, "rooms", match[1]))) continue;
  const [, roomId, memberId] = match;
  referenced.add(resolve(source));
  try {
    validateLegacySource(source, join(runtimeRoot, roomId, memberId, "sessions"));
    const header = readHeader(source);
    const sourceHash = sha256(source);
    if (!checkDuplicate(source, header.id, sourceHash, `room:${roomId}`)) continue;
    const day = new Date(header.timestamp).toISOString().slice(0, 10);
    const targetRelative = join("members", memberId, "sessions", day, "rooms", roomId, source.split("/").at(-1));
    const target = join(root, targetRelative);
    validateTarget(target, memberId);
    const targetState = existsSync(target) ? (sha256(target) === sourceHash ? "identical" : "different") : "absent";
    if (targetState === "different") { conflict(target, "target-exists-different-content", { source, scopeId: `room:${roomId}`, memberId }); continue; }
    if (targetState === "identical") stats.skippedIdentical++;
    const plan = { source, target, targetRelative, memberId, scopeId: `room:${roomId}`, sessionId: header.id, size: statSync(source).size, sha256: sourceHash, targetState, publishCurrent: false };
    plans.push(plan); stats.planned++;
    emit({ kind: "plan", ...plan, referenceChange: null, status: targetState === "identical" ? "already-copied" : "ready", currentStatus: "historical-only-no-legacy-current-reference" });
  } catch (cause) { error(source, "room-history-read-failed", String(cause)); }
}
const orphanRoots = [runtimeRoot, join(root, "rooms")];
for (const orphanRoot of orphanRoots) for (const file of await walk(orphanRoot)) {
  if (!file.endsWith(".jsonl") || !file.includes("/sessions/") || referenced.has(resolve(file))) continue;
  try { readHeader(file); }
  catch { continue; } // Product message/event JSONL is not an SDK session candidate.
  conflict(file, "unresolved-owner", { detail: "SDK session header found without an authoritative member/scope reference" });
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
      if (injectedFailure === "after-copy") throw new Error("injected failure after copy");
    }
    const byMember = new Map();
    for (const plan of plans) {
      if (!plan.publishCurrent) continue;
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
      const merged = { ...(original ? JSON.parse(original.toString("utf8")) : {}), ...additions };
      mkdirSync(dirname(path), { recursive: true });
      const currentTemp = `${path}.${process.pid}.migration.tmp`;
      writeFileSync(currentTemp, JSON.stringify(merged, null, 2) + "\n");
      recovery.currentBackups.push({ memberId, path, existed: original !== null, originalBase64: original?.toString("base64") ?? null, publishedSha256: sha256(currentTemp) });
    }
    recovery.copiedTargets = staged.map((item) => item.target);
    mkdirSync(dirname(recoveryPath), { recursive: true });
    const recoveryTemp = `${recoveryPath}.${process.pid}.tmp`;
    writeFileSync(recoveryTemp, JSON.stringify({ format: "member-session-recovery/v1", state: "prepared", generatedAt: new Date().toISOString(), ...recovery }, null, 2) + "\n");
    renameSync(recoveryTemp, recoveryPath);
    stats.writes++;
    for (const item of staged) { renameSync(item.temp, item.target); stats.writes++; }
    if (injectedFailure === "publish-current" || injectedFailure === "publish-and-rollback") throw new Error("injected current publish failure");
    let publishedCurrents = 0;
    for (const path of currentBackups.keys()) {
      renameSync(`${path}.${process.pid}.migration.tmp`, path);
      stats.writes++;
      publishedCurrents++;
      if (injectedFailure === "after-first-current-publish" && publishedCurrents === 1) process.exit(86);
    }
    const complete = JSON.parse(readFileSync(recoveryPath, "utf8"));
    complete.state = "complete";
    complete.completedAt = new Date().toISOString();
    writeFileSync(`${recoveryPath}.${process.pid}.tmp`, JSON.stringify(complete, null, 2) + "\n");
    renameSync(`${recoveryPath}.${process.pid}.tmp`, recoveryPath);
    stats.writes++;
  } catch (cause) {
    error(root, "apply-failed", String(cause));
    for (const item of staged) rmSync(item.temp, { force: true });
    for (const [path, original] of currentBackups) {
      try {
        rmSync(`${path}.${process.pid}.migration.tmp`, { force: true });
        const recoveryItem = recovery.currentBackups.find((item) => item.path === path);
        const published = recoveryItem?.publishedSha256;
        const currentHash = existsSync(path) ? sha256(path) : null;
        const originalHash = original ? createHash("sha256").update(original).digest("hex") : null;
        if (currentHash === published) {
          restoreOriginalCurrent(recoveryItem);
        } else if (currentHash !== originalHash) {
          conflict(path, "rollback-current-changed", { currentSha256: currentHash, publishedSha256: published, originalSha256: originalHash });
        }
        if (injectedFailure === "publish-and-rollback") throw new Error("injected rollback failure");
      } catch (rollbackCause) { error(path, "rollback-failed", String(rollbackCause)); }
    }
    emit({ kind: "recovery", status: stats.conflicts || stats.errors > 1 ? "manual-required" : "references-restored", recoveryPath, ...recovery });
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
