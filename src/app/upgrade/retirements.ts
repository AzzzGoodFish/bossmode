import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, rmdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { ensurePrivateDirectory, syncPath, writeDurably } from "../../files/io.js";
import { createHash } from "node:crypto";
import { type Database } from "../../data/database.js";
import { logger } from "../../kernel/logger.js";

const TASK_TABLES = ["tasks", "task_references", "task_subscribers", "task_comments"] as const;

/** Locate (or create) the dated retirement archive directory under `<root>/archive`. */
export function taskRetirementDir(root: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = join(root, "archive");
  ensurePrivateDirectory(base);
  let directory = join(base, `task-retirement-${stamp}`);
  for (let n = 1; existsSync(directory); n++) directory = join(base, `task-retirement-${stamp}-${n}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncPath(base);
  return directory;
}

/**
 * Preserve a legacy task source file (e.g. rooms/<room>/tasks.json) verbatim in the
 * retirement archive. Returns the archived file name. Used by the conversation
 * importer for legacy task files that are no longer imported into SQL.
 */
export function archiveRawRetiredSource(root: string, legacyPath: string, bytes: Uint8Array): string {
  const directory = taskRetirementDir(root);
  const safe = legacyPath.replace(/[^A-Za-z0-9._-]+/g, "__");
  const file = `legacy-source__${safe}`;
  const path = join(directory, file);
  writeDurably(path, bytes);
  const onDisk = readFileSync(path);
  if (sha256(onDisk) !== sha256(bytes)) throw new Error(`Task retirement archive verification failed: ${file}`);
  syncPath(path);
  return file;
}

export interface TaskArchiveResult {
  directory: string;
  exportedFiles: string[];
  rowCounts: Record<string, number>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table));
}

/**
 * Export all four task tables from the staging database, then verify the written
 * bytes. Returns the archive directory. Safe to call when the tables never existed
 * (fresh install): writes nothing and returns zero counts.
 */
export function archiveRetiredTasks(stagingDb: Database, root: string): TaskArchiveResult | null {
  const present = TASK_TABLES.filter((table) => tableExists(stagingDb, table));
  if (present.length === 0) return null;

  const directory = taskRetirementDir(root);

  const rowCounts: Record<string, number> = {};
  const exportedFiles: string[] = [];
  const checksumLines: string[] = [];

  // Full-table JSON export, one file per table, deterministic column order.
  for (const table of present) {
    const rows = stagingDb.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    rowCounts[table] = rows.length;
    const payload = JSON.stringify({ table, exportedAt: new Date().toISOString(), rowCount: rows.length, rows }, null, 2);
    const file = `${table}.json`;
    const bytes = Buffer.from(payload, "utf8");
    const path = join(directory, file);
    writeDurably(path, bytes);
    // Verify the bytes read back match what we intended to write.
    const onDisk = readFileSync(path);
    if (sha256(onDisk) !== sha256(bytes)) throw new Error(`Task retirement archive verification failed: ${file}`);
    checksumLines.push(`${sha256(bytes)}  ${file}`);
    exportedFiles.push(file);
  }

  const manifest = checksumLines.join("\n") + "\n";
  writeDurably(join(directory, "SHA256SUMS"), Buffer.from(manifest, "utf8"));
  exportedFiles.push("SHA256SUMS");

  const total = Object.values(rowCounts).reduce((n, c) => n + c, 0);
  const readme = [
    "# Retired: Task feature data archive",
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
    "## Why this archive exists",
    "",
    "The Task feature (task board, `/api/tasks` HTTP API, the `create_task` / `update_task` /",
    "`list_tasks` / `get_task` / `comment_task` member tools, and the `task:` mainline reference)",
    "was retired on 2026-09-11 by decision of the product owner (fish #19253/#19256/#19259).",
    "The four task SQL tables were exported here, verified, and then dropped.",
    "",
    "Historical chat messages of type `task_event` were NOT modified — they remain in the",
    "message store verbatim and still render as plain text in the chat history.",
    "",
    "## Tables exported",
    "",
    ...TASK_TABLES.map((t) => `- \`${t}\`: ${rowCounts[t] ?? "(absent)"} rows`),
    "",
    `Total rows: ${total}`,
    "",
    "## Files",
    "",
    "- `tasks.json` — `tasks` rows",
    "- `task_references.json` — `task_references` rows",
    "- `task_subscribers.json` — `task_subscribers` rows",
    "- `task_comments.json` — `task_comments` rows",
    "- `SHA256SUMS` — sha256 of each JSON export, verifiable with `sha256sum -c SHA256SUMS`",
    "",
    "## Restoring",
    "",
    "This archive is a read-only record, not a supported restore path. The application",
    "no longer creates or reads these tables. To inspect, use any JSON/SQLite tooling;",
    "each file is a JSON object with `table`, `exportedAt`, `rowCount` and `rows`.",
    "",
  ].join("\n");
  writeDurably(join(directory, "README.md"), Buffer.from(readme, "utf8"));
  exportedFiles.push("README.md");

  for (const file of exportedFiles) syncPath(join(directory, file));
  syncPath(directory);
  return { directory, exportedFiles, rowCounts };
}

const TOPIC_CLEANUP_FLAG = "core-topic-session-cleanup-v1";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const MEMBER_ID = /^mem_[A-Za-z0-9-]+$/;

/**
 * Delete retired topic session directories from member session trees (topic
 * retirement §3.4, fish #19358). Runs after the storage upgrade settles.
 *
 * - Idempotent: a storage_meta flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry.
 * - Non-blocking: file-only leftovers never affect main chat data, so failures
 *   are logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `<member>/sessions/<day>/topics/…` and legacy `topic-…`
 *   prefixed directories inside session day trees are matched; room/DM session
 *   files and the `sessions/current.json` reference file are never touched.
 */
export function cleanupRetiredTopicSessionFiles(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", TOPIC_CLEANUP_FLAG)) return;
    const membersRoot = join(root, "members");
    let removed = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const sessionsRoot = join(membersRoot, member.name, "sessions");
        if (!existsSync(sessionsRoot)) continue;
        for (const day of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!day.isDirectory() || !DAY.test(day.name)) continue;
          const dayDir = join(sessionsRoot, day.name);
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            // Real directories only: symlinks and files are never matched (or followed).
            if (!entry.isDirectory()) continue;
            if (entry.name !== "topics" && !entry.name.startsWith("topic-")) continue;
            rmSync(join(dayDir, entry.name), { recursive: true, force: true });
            removed += 1;
          }
        }
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", TOPIC_CLEANUP_FLAG,
      JSON.stringify({ removedDirectories: removed, completedAt: Date.now() }));
    if (removed) logger.info("storage-upgrade", "Retired topic session directories removed", { removed });
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired topic session cleanup pending (will retry next startup): ${String(error)}`);
  }
}

const BACKGROUND_CLEANUP_FLAG = "core-background-session-cleanup-v1";

/**
 * Delete retired background-task directories from member trees (background
 * retirement, fish #19454). Runs after the storage upgrade settles.
 *
 * - Idempotent: a storage_meta flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry.
 * - Non-blocking: file-only leftovers never affect main chat data, so failures
 *   are logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `<member>/background-tasks/…` is matched; member session
 *   files, room/DM session trees and `sessions/current.json` are never
 *   touched. (Topic-scoped background children wrote into the same tree before
 *   their own retirement, so this also clears those residuals.)
 */
export function cleanupRetiredBackgroundSessionFiles(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", BACKGROUND_CLEANUP_FLAG)) return;
    const membersRoot = join(root, "members");
    let removed = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const dir = join(membersRoot, member.name, "background-tasks");
        if (!existsSync(dir)) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", BACKGROUND_CLEANUP_FLAG,
      JSON.stringify({ removedDirectories: removed, completedAt: Date.now() }));
    if (removed) logger.info("storage-upgrade", "Retired background task directories removed", { removed });
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired background session cleanup pending (will retry next startup): ${String(error)}`);
  }
}

const SESSION_ARCHIVE_FLAG = "core-member-session-archive-v1";

/** Directories the member-level session layout replaced (① A2). */
const RETIRED_DIRS = new Set(["rooms", "dm"]);

/** Retired scope-keyed session reference file (pre-DB layout). */
const RETIRED_FILE = "current.json";

/**
 * Park retired per-scope session artifacts in `members/<id>/archive/sessions/`
 * (① A3, fish #20025). A member now has one session under
 * `sessions/<day>/main/`; the old `rooms/<room>` and `dm` trees — and the legacy
 * `sessions/current.json` reference file — are moved aside rather than deleted,
 * so nothing is lost and nothing resumes them. Runs after the storage upgrade
 * settles, alongside the other retirement cleanups.
 *
 * - Idempotent: a `storage_meta` flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry, but files arriving after the
 *   flag are deliberately left in place.
 * - Non-blocking: file-only leftovers never affect chat data, so failures are
 *   logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `sessions/<day>/{rooms,dm}` directories and `sessions/current.json`
 *   are matched; `sessions/<day>/main/` and everything else under the member
 *   directory stays untouched. Symlinks are never followed or moved.
 * - Never overwrites: if the archive already holds the target path it is left
 *   alone and the conflict is counted (no merge, no clobber).
 */
export function archiveRetiredScopeSessions(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", SESSION_ARCHIVE_FLAG)) return;
    const membersRoot = join(root, "members");
    let moved = 0;
    let skipped = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const memberRoot = join(membersRoot, member.name);
        const sessionsRoot = join(memberRoot, "sessions");
        if (!existsSync(sessionsRoot)) continue;
        const archiveRoot = join(memberRoot, "archive", "sessions");
        for (const day of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!day.isDirectory() || !DAY.test(day.name)) continue;
          const dayDir = join(sessionsRoot, day.name);
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            // Real directories only: symlinks and files are never matched (or followed).
            if (!entry.isDirectory() || !RETIRED_DIRS.has(entry.name)) continue;
            const target = join(archiveRoot, day.name, entry.name);
            if (existsSync(target)) {
              skipped += 1;
              continue;
            }
            mkdirSync(dirname(target), { recursive: true });
            renameSync(join(dayDir, entry.name), target);
            moved += 1;
          }
        }
        const reference = join(sessionsRoot, RETIRED_FILE);
        if (existsSync(reference)) {
          const target = join(archiveRoot, RETIRED_FILE);
          if (existsSync(target)) skipped += 1;
          else {
            mkdirSync(dirname(target), { recursive: true });
            renameSync(reference, target);
            moved += 1;
          }
        }
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SESSION_ARCHIVE_FLAG,
      JSON.stringify({ movedEntries: moved, skippedConflicts: skipped, completedAt: Date.now() }));
    if (moved || skipped) {
      logger.info("storage-upgrade", "Retired scope session files archived", { moved, skipped });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired scope session archive pending (will retry next startup): ${String(error)}`);
  }
}

const SHARED_FLAG = "core-global-archive-v1";

const SCOPES_FLAG = "core-member-memory-scopes-v1";

/** Recursively list files (relative, POSIX-ish) without following symlinks. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(relative(root, absolute).split("\\").join("/"));
      // Symlinks are deliberately neither followed nor listed.
    }
  };
  walk(root);
  return out;
}

function removeIfEmpty(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir); // rmSync(..., {recursive:false}) rejects directories (EISDIR)
    return true;
  } catch {
    return false;
  }
}

/**
 * ④ A (fish #20035): the legacy shared memory (`memory/user`, `memory/projects`)
 * is retired with the member-private memory model. On upgrade the content moves
 * to the workspace-level global archive (`<root>/archive/memory/<source>`) —
 * read-only history, nothing deleted, nothing merged: if the archive target
 * already exists the source is left in place and the conflict is counted.
 * Idempotent via a `storage_meta` flag; failures are logged and retried next
 * start (matches the other post-upgrade file cleanups).
 */
export function archiveLegacySharedMemory(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", SHARED_FLAG)) return;
    const archiveRoot = join(root, "archive");
    const sources: Array<{ from: string; to: string }> = [
      { from: join(root, "memory", "user"), to: join(archiveRoot, "memory", "user") },
      { from: join(root, "memory", "projects"), to: join(archiveRoot, "memory", "projects") },
    ];
    let moved = 0;
    let skipped = 0;
    let cleaned = 0;
    for (const { from, to } of sources) {
      if (!existsSync(from)) continue;
      if (listFiles(from).length === 0) {
        // Empty shells carry nothing to preserve — tidy them away.
        if (removeIfEmpty(from)) cleaned += 1;
        else skipped += 1;
        continue;
      }
      if (existsSync(to)) {
        skipped += 1; // never merge or clobber; leave the source for a human to inspect
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      moved += 1;
    }
    removeIfEmpty(join(root, "memory"));
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SHARED_FLAG,
      JSON.stringify({ movedRoots: moved, skippedConflicts: skipped, cleanedEmpty: cleaned, completedAt: Date.now() }));
    if (moved || skipped || cleaned) {
      logger.info("storage-upgrade", "Legacy shared memory archived to global archive", { moved, skipped, cleaned, archiveRoot });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Legacy shared memory archive pending (will retry next startup): ${String(error)}`);
  }
}

/**
 * ④ B (fish #20035): `memory/scopes/` was the retired per-chat memory layout.
 * Fold any remaining files into the member's overview+parts root as
 * `scopes-<path-with-dashes>.md` (nothing lost, deterministic names), then drop
 * the empty tree. A member with an empty `scopes/` just gets the tree removed.
 * The fold only MOVES bytes, so the registry/history rows follow the move:
 * `reconcileFoldedMemoryRows` runs on every startup (idempotent, conservative:
 * only when the source is gone and the folded file exists; conflicts stay) and
 * also heals databases whose fold flag was already set by an earlier build.
 * The move phase stays flag-gated; non-blocking on failure (retry next start).
 */
export function cleanupMemberMemoryScopes(root: string, db: Database): void {
  try {
    const foldedFlagDone = !!db.get("SELECT 1 FROM storage_meta WHERE key=?", SCOPES_FLAG);
    const membersRoot = join(root, "members");
    let folded = 0;
    let cleaned = 0;
    let skipped = 0;
    if (!foldedFlagDone && existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const memoryRoot = join(membersRoot, member.name, "memory");
        const scopesRoot = join(memoryRoot, "scopes");
        if (!existsSync(scopesRoot)) continue;
        const files = listFiles(scopesRoot);
        if (files.length === 0) {
          if (removeIfEmpty(scopesRoot)) cleaned += 1;
          continue;
        }
        for (const rel of files) {
          const target = join(memoryRoot, `scopes-${rel.replace(/\//g, "-")}`);
          if (existsSync(target)) {
            skipped += 1;
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          renameSync(join(scopesRoot, rel), target);
          folded += 1;
        }
        // Remove the tree if every file moved out (leftovers stay on conflict).
        if (listFiles(scopesRoot).length === 0) rmSync(scopesRoot, { recursive: true });
      }
    }
    const repointed = reconcileFoldedMemoryRows(root, db);
    if (!foldedFlagDone) {
      db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SCOPES_FLAG,
        JSON.stringify({ foldedFiles: folded, cleanedEmpty: cleaned, skippedConflicts: skipped, repointedRows: repointed, completedAt: Date.now() }));
    }
    if (folded || cleaned || skipped || repointed) {
      logger.info("storage-upgrade", "Member memory/scopes folded into the member memory root", { folded, cleaned, skipped, repointed });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Member memory scopes fold pending (will retry next startup): ${String(error)}`);
  }
}

const FOLD_REPOINT_TARGETS = [
  ["memory_documents", "path"],
  ["memory_document_history", "document_path"],
  ["memory_document_history", "snapshot_path"],
] as const;

/** `members/<id>/memory/scopes/<rel>` → `members/<id>/memory/scopes-<rel flattened>`.
 * Repoints only rows whose source is gone and whose folded file exists (covers runs
 * interrupted between the move and this step); a conflict (both present) stays put.
 * Idempotent — safe on every startup. */
function reconcileFoldedMemoryRows(root: string, db: Database): number {
  const membersRoot = join(root, "members");
  if (!existsSync(membersRoot)) return 0;
  let repointed = 0;
  for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
    if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
    const prefix = `members/${member.name}/memory/scopes/`;
    const updates: Array<{ table: string; column: string; rowid: number; next: string }> = [];
    for (const [table, column] of FOLD_REPOINT_TARGETS) {
      const rows = db.all<{ r: number; v: string }>(`SELECT rowid AS r, "${column}" AS v FROM "${table}" WHERE "${column}" LIKE ?`, `${prefix}%`);
      for (const row of rows) {
        const next = `members/${member.name}/memory/scopes-${row.v.slice(prefix.length).replace(/\//g, "-")}`;
        if (!existsSync(join(root, row.v)) && existsSync(join(root, next))) {
          updates.push({ table, column, rowid: row.r, next });
        }
      }
    }
    if (updates.length === 0) continue;
    db.transaction((tx) => {
      tx.exec("PRAGMA defer_foreign_keys=ON"); // history.document_path references memory_documents(path)
      for (const update of updates) tx.run(`UPDATE "${update.table}" SET "${update.column}"=? WHERE rowid=?`, update.next, update.rowid);
    });
    repointed += updates.length;
  }
  return repointed;
}

const COPY_FLAG = "core-room-description-copy-v1";

/**
 * One-time copy of the legacy room-scoped principles content
 * (`rooms/<id>/memory/room-principles.md`) into the explicit
 * `rooms.description` column added by `core-room-description-v1`.
 * Nothing is deleted or truncated: legacy content becomes the initial
 * description as-is, even when it exceeds the 2000-char edit limit.
 * Idempotent via a `storage_meta` flag; failures retry next startup.
 */
export function copyRoomPrinciplesToDescriptions(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", COPY_FLAG)) return;
    const rooms = db.all<{ id: string }>("SELECT id FROM rooms WHERE description IS NULL");
    let copied = 0;
    for (const { id } of rooms) {
      const path = join(root, "rooms", id, "memory", "room-principles.md");
      if (!existsSync(path)) continue;
      const content = readFileSync(path, "utf-8").trim();
      if (!content) continue;
      db.run("UPDATE rooms SET description=? WHERE id=? AND description IS NULL", content, id);
      copied += 1;
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", COPY_FLAG,
      JSON.stringify({ copied, completedAt: Date.now() }));
    if (copied) logger.info("storage-upgrade", "Room principles copied into room descriptions", { copied });
  } catch (error) {
    logger.warn("storage-upgrade",
      `Room description copy pending (will retry next startup): ${String(error)}`);
  }
}
