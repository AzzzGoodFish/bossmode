#!/usr/bin/env node
/** One-time, offline member storage cutover. Never used as a runtime fallback. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, chmodSync, fsyncSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { parseDocument } from "yaml";

const argv = process.argv.slice(2);
const actions = ["--dry-run", "--apply", "--recover"];
const failAt = process.env.BOSSMODE_MEMBER_STORAGE_TEST_FAIL_AT;
const report = [];
let output;
let outputValidated = false;
let root;
let journalPath;
let db;
let lockDb;
const emit = (record) => report.push(record);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const fail = (message) => { throw new Error(message); };
function present(path) {
  try { lstatSync(path); return true; } catch (err) { if (err.code === "ENOENT") return false; throw err; }
}
function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Expected a regular file, not a link: ${path}`);
}
function syncDir(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path); syncDir(dirname(path));
}
function save(journal) { atomicWrite(journalPath, `${JSON.stringify(journal, null, 2)}\n`); }
function injected(phase) { if (failAt === phase) process.exit(86); }
function stopped() {
  const pidPath = join(root, "bossmode.pid");
  if (!present(pidPath)) return;
  regular(pidPath);
  const text = readFileSync(pidPath, "utf8").trim();
  if (!/^[1-9]\d*$/.test(text)) fail("Cannot verify stopped service: invalid bossmode.pid");
  try { process.kill(Number(text), 0); }
  catch (err) { if (err.code === "ESRCH") return; throw err; }
  fail("Bossmode is running. Stop it before apply/recover.");
}
function acquireLock() {
  const migrationDir = join(root, "migrations");
  if (present(migrationDir) && (lstatSync(migrationDir).isSymbolicLink() || !lstatSync(migrationDir).isDirectory())) fail("Unsafe migration directory");
  mkdirSync(migrationDir, { recursive: true });
  syncDir(root);
  const path = join(migrationDir, "member-storage-v1.lock.sqlite");
  if (present(path)) regular(path);
  lockDb = new DatabaseSync(path);
  chmodSync(path, 0o600);
  // A separate SQLite lock is released by the OS on death. Never unlink a lock
  // file after checking a PID: another recoverer may already own its replacement.
  try { lockDb.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS migration_lock (marker INTEGER)"); }
  catch (error) { lockDb.close(); lockDb = undefined; fail(`Cannot acquire migration lock: ${error.message}`); }
}
async function backupDatabase(journal) {
  if (!journal.databaseExisted) return;
  const path = join(root, "bossmode.db");
  if (!present(path)) return;
  const destination = join(root, "migrations", "member-storage-v1-backup", "database-before.sqlite");
  if (present(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  syncDir(dirname(dirname(destination)));
  const conn = new DatabaseSync(path, { readOnly: true });
  const pending = destination + ".pending";
  if (present(pending)) { regular(pending); unlinkSync(pending); }
  try { await backup(conn, pending); } finally { conn.close(); }
  const fd = openSync(pending, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(pending, destination); syncDir(dirname(destination));
}
function readRows() {
  const path = join(root, "bossmode.db");
  if (!present(path)) return [];
  regular(path);
  const conn = new DatabaseSync(path, { readOnly: true });
  try {
    const table = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get();
    return table ? conn.prepare("SELECT * FROM members").all() : [];
  } finally { conn.close(); }
}
function expectedRow(rec) {
  return { id: rec.id, name: rec.name, name_key: rec.name.toLowerCase(), title: rec.title || null,
    agent_template: rec.agentTemplate, global_json: JSON.stringify(rec.global), created_at: rec.createdAt, updated_at: rec.updatedAt };
}
function matchesRow(row, rec) {
  const expected = expectedRow(rec);
  return Object.keys(expected).every((key) => key === "global_json"
    ? JSON.stringify(JSON.parse(row[key])) === expected[key] : row[key] === expected[key]);
}
function personaFromOld(bytes, path) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const prefix = text.match(/^(?:\uFEFF)?---\r?\n/);
  if (!prefix) return { body: bytes, title: undefined };
  const remaining = text.slice(prefix[0].length);
  const close = /^(?:---|\.\.\.)\r?(?:\n|$)/m.exec(remaining);
  if (!close) fail(`Unterminated old frontmatter: ${path}`);
  const doc = parseDocument(remaining.slice(0, close.index), { uniqueKeys: true });
  if (doc.errors.length) fail(`Invalid old frontmatter: ${path}: ${doc.errors[0].message}`);
  const meta = doc.toJS({ maxAliasCount: 100 });
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) fail(`Old frontmatter must be a mapping: ${path}`);
  if (meta.title !== undefined && typeof meta.title !== "string") fail(`Non-string title: ${path}`);
  if (meta.name !== undefined && typeof meta.name !== "string") fail(`Non-string profile name: ${path}`);
  // Slice original bytes, not normalized Markdown. Includes every newline after the closing delimiter.
  const consumed = prefix[0] + remaining.slice(0, close.index + close[0].length);
  const offset = Buffer.byteLength(consumed, "utf8") + (bytes[0] === 0xef && !text.startsWith("\uFEFF") ? 3 : 0);
  return { body: bytes.subarray(offset), title: meta.title?.trim() || undefined, profileName: meta.name };
}
function parseRecord(bytes, id) {
  const rec = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!rec || rec.id !== id || !/^mem_[a-zA-Z0-9_-]+$/.test(id)) fail(`Directory/record ID mismatch: ${id}`);
  if (typeof rec.name !== "string" || !rec.name.trim() || rec.name.trim().length > 64 || /[/\0]/.test(rec.name)) fail(`Invalid name: ${id}`);
  if (typeof rec.agentTemplate !== "string" || !rec.agentTemplate || !rec.global || typeof rec.global !== "object" || Array.isArray(rec.global) ||
      !Number.isSafeInteger(rec.createdAt) || !Number.isSafeInteger(rec.updatedAt)) fail(`Invalid member record: ${id}`);
  const { extensions: retired, ...global } = rec.global;
  return { id, name: rec.name.trim(), agentTemplate: rec.agentTemplate, global, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {} };
}
function planMigration() {
  const plans = [];
  const names = new Set(readRows().map((row) => row.name_key));
  const ids = new Set(readRows().map((row) => row.id));
  const directory = join(root, "members");
  if (!present(directory)) return plans;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.startsWith("mem_")) continue;
    if (!entry.isDirectory()) fail(`Member directory must not be a link: ${entry.name}`);
    const home = join(directory, entry.name);
    const source = join(home, "member.json");
    if (!present(source)) {
      if (present(join(home, "member.md"))) fail(`Old profile has no member.json: ${home}`);
      continue;
    }
    regular(source);
    const record = parseRecord(readFileSync(source), entry.name);
    if (ids.has(record.id) || names.has(record.name.toLowerCase())) fail(`Duplicate member ID or normalized name: ${record.id} (${record.name})`);
    ids.add(record.id); names.add(record.name.toLowerCase());
    const oldProfile = join(home, "member.md");
    const legacy = join(home, "memory", "persona.md");
    if (present(legacy)) { regular(legacy); if (readFileSync(legacy, "utf8").trim()) fail(`Unmerged legacy memory/persona.md: ${home}`); }
    let converted = { body: Buffer.alloc(0), title: undefined };
    const sources = [source];
    if (present(oldProfile)) {
      regular(oldProfile); converted = personaFromOld(readFileSync(oldProfile), oldProfile); sources.push(oldProfile);
      if (converted.profileName !== undefined && converted.profileName !== record.name) emit({ kind: "warning", memberId: record.id, reason: "profile-name-differs", authoritativeName: record.name, profileName: converted.profileName });
    }
    if (converted.title !== undefined) record.title = converted.title;
    const target = join(home, "persona.md");
    const bodyHash = hash(converted.body);
    if (present(target)) {
      regular(target);
      if (fileHash(target) !== bodyHash) fail(`Conflicting existing persona.md: ${target}`);
    }
    plans.push({ record, target, bodyBase64: converted.body.toString("base64"), bodyHash,
      targetExisted: present(target), sources: sources.map((path) => ({ path, hash: fileHash(path),
        backup: join(root, "migrations", "member-storage-v1-backup", record.id, path.endsWith("member.json") ? "member.json" : "member.md") })) });
    emit({ kind: "plan", memberId: record.id, name: record.name, title: record.title ?? null, target, bodyHash, sources: sources.map((path) => ({ path, hash: fileHash(path) })) });
  }
  return plans;
}
function verifyJournal(journal) {
  if (journal.version !== 1 || journal.root !== root || typeof journal.databaseExisted !== "boolean" || !Array.isArray(journal.plans) || !["pending", "done"].includes(journal.status)) fail("Invalid migration journal");
  for (const plan of journal.plans) {
    const home = join(root, "members", plan.record.id);
    if (!/^mem_[a-zA-Z0-9_-]+$/.test(plan.record.id) || plan.target !== join(home, "persona.md") || hash(Buffer.from(plan.bodyBase64, "base64")) !== plan.bodyHash) fail("Invalid journal plan");
    for (const source of plan.sources) {
      if (![join(home, "member.json"), join(home, "member.md")].includes(source.path) || source.backup !== join(root, "migrations", "member-storage-v1-backup", plan.record.id, source.path.endsWith("member.json") ? "member.json" : "member.md")) fail("Invalid journal source path");
    }
  }
}
function verifyPending(journal) {
  for (const plan of journal.plans) {
    for (const source of plan.sources) {
      const oldExists = present(source.path); const backupExists = present(source.backup);
      if (!oldExists && !backupExists) fail(`Missing source and backup: ${source.path}`);
      for (const path of [source.path, source.backup].filter(present)) { regular(path); if (fileHash(path) !== source.hash) fail(`Changed source/backup: ${path}`); }
      if (!oldExists && !["committing", "db-committed", "retiring"].includes(journal.phase)) fail(`Source retired before database commit: ${source.path}`);
    }
    if (present(plan.target)) { regular(plan.target); if (fileHash(plan.target) !== plan.bodyHash) fail(`Changed persona target: ${plan.target}`); }
    else if (plan.targetExisted || ["db-committed", "retiring"].includes(journal.phase)) fail(`Missing persona target: ${plan.target}`);
  }
  if (["committing", "db-committed", "retiring"].includes(journal.phase) && !present(join(root, "bossmode.db"))) fail("Database missing after commit preparation; manual recovery required");
  const rows = readRows();
  let existing = 0;
  for (const plan of journal.plans) {
    const row = rows.find((row) => row.id === plan.record.id);
    if (row) { if (!matchesRow(row, plan.record)) fail(`Changed database member: ${plan.record.id}`); existing++; }
    else if (rows.some((row) => row.name_key === plan.record.name.toLowerCase())) fail(`Database name conflict: ${plan.record.name}`);
  }
  if (existing !== 0 && existing !== journal.plans.length) fail("Partial database import; manual recovery required");
  if (journal.plans.length && ["db-committed", "retiring"].includes(journal.phase) && !existing) fail("Committed member records are missing");
  return existing === journal.plans.length;
}
async function applyJournal(journal) {
  const committed = verifyPending(journal);
  await backupDatabase(journal);
  process.env.BOSSMODE_DIR = root;
  const { openDb } = await import("../dist/workspace/db/sqlite.js");
  const { importMemberRecord } = await import("../dist/workspace/member-registry.js");
  db = openDb();
  for (const plan of journal.plans) {
    if (!present(plan.target)) atomicWrite(plan.target, Buffer.from(plan.bodyBase64, "base64"));
    if (fileHash(plan.target) !== plan.bodyHash) fail(`Persona verification failed: ${plan.target}`);
    injected("after-first-persona");
  }
  journal.phase = "committing"; save(journal); injected("before-db-commit");
  if (!committed) {
    db.transaction(() => {
      for (const plan of journal.plans) importMemberRecord(plan.record);
      injected("during-db-transaction");
    });
  }
  injected("after-db-commit");
  journal.phase = "db-committed"; save(journal);
  verifyPending(journal);
  journal.phase = "retiring"; save(journal);
  for (const plan of journal.plans) for (const source of plan.sources) {
    if (present(source.path)) {
      if (present(source.backup)) fail(`Both source and backup exist; refusing overwrite: ${source.path}`);
      mkdirSync(dirname(source.backup), { recursive: true });
      syncDir(dirname(dirname(source.backup)));
      // Persist the backup root itself when no pre-existing database created it.
      syncDir(join(root, "migrations"));
      renameSync(source.path, source.backup); syncDir(dirname(source.path)); syncDir(dirname(source.backup));
    }
    injected("after-first-retire");
  }
  journal.status = "done"; journal.phase = "complete"; journal.completedAt = new Date().toISOString(); save(journal);
  emit({ kind: "applied", members: journal.plans.length });
}

let exitCode = 0;
try {
  let action;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (actions.includes(arg)) { if (action) fail("Choose exactly one migration action"); action = arg; }
    else if (arg === "--bossmode-dir" || arg === "--output") {
      const value = argv[++i]; if (!value || value.startsWith("--")) fail(`Missing value for ${arg}`);
      if (arg === "--bossmode-dir") { if (root) fail("Repeated root option"); root = value; } else output = resolve(value);
    } else fail(`Unknown argument: ${arg}`);
  }
  if (!action || !root || !isAbsolute(root)) fail("Use --dry-run, --apply, or --recover with --bossmode-dir <absolute directory> [--output file]");
  root = realpathSync(root); journalPath = join(root, "migrations", "member-storage-v1.json");
  if (output) output = join(realpathSync(dirname(output)), basename(output));
  if (output && (output === journalPath || output.startsWith(join(root, "members") + "/") || output.startsWith(join(root, "migrations") + "/") || output === join(root, "bossmode.db") || output === join(root, "bossmode.pid"))) fail("Report path must not overlap member, migration, database or PID storage");
  if (output && present(output)) fail("Report already exists; choose a new output path");
  outputValidated = true;
  if (action !== "--dry-run") stopped();
  if (present(journalPath)) {
    if (action !== "--dry-run") acquireLock();
    regular(journalPath); const journal = JSON.parse(readFileSync(journalPath, "utf8")); verifyJournal(journal);
    if (journal.status === "done") {
      if (!present(join(root, "bossmode.db"))) fail("Completed migration database is missing; restore a database backup, do not reimport old members");
      const check = new DatabaseSync(join(root, "bossmode.db"), { readOnly: true });
      try {
        if (!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='members'").get() || !check.prepare("SELECT id FROM schema_migrations WHERE id='member-storage-v1'").get()) fail("Completed migration identity schema is missing; restore a verified database backup");
      } finally { check.close(); }
      readRows(); // Never overwrite members edited since migration.
      emit({ kind: "already-complete", members: journal.plans.length });
    } else {
      if (action !== "--recover") fail("Pending migration; keep service stopped and run --recover");
      await applyJournal(journal);
    }
  } else {
    if (action === "--recover") fail("No migration journal to recover");
    const plans = planMigration();
    if (action === "--apply") {
      acquireLock();
      if (present(journalPath)) fail("Migration state changed during planning; retry after review");
      const journal = { version: 1, root, databaseExisted: present(join(root, "bossmode.db")), status: "pending", phase: "prepared", startedAt: new Date().toISOString(), plans };
      save(journal); injected("after-journal"); await applyJournal(journal);
    }
  }
} catch (err) { exitCode = 2; emit({ kind: "conflict", reason: String(err?.message || err) }); }
finally {
  if (db) db.close();
  if (lockDb) { try { lockDb.exec("COMMIT"); } finally { lockDb.close(); } }
  emit({ kind: "summary", exitCode });
  const text = report.map((row) => JSON.stringify(row)).join("\n") + "\n";
  if (output && outputValidated) { try { if (existsSync(output)) fail("Report already exists; choose a new output path"); writeFileSync(output, text, { flag: "wx", mode: 0o600 }); } catch (err) { console.error(String(err)); exitCode = 1; } }
  process.stdout.write(text); process.exitCode = exitCode;
}
