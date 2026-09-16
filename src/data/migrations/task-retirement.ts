// Task feature retirement archive (fish #19259/#19261, 2026-09-11).
//
// The Task feature (board, HTTP API, member tools, mainline `task:` ref) is retired
// and its four SQL tables are dropped by the `core-task-retirement-v1` migration.
// Before that drop, this module exports every task row from the staging database to
// the runtime archive directory, verifies the export bytes, and writes a checksum
// manifest plus a README. A failed or mismatched export aborts the upgrade — the
// tables are never dropped without a verified archive on disk.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Database } from "../database.js";
import { ensurePrivateDirectory, syncDirectory, syncFile, writeDurably } from "../upgrade/upgrade-files.js";

const TASK_TABLES = ["tasks", "task_references", "task_subscribers", "task_comments"] as const;

/** Locate (or create) the dated retirement archive directory under `<root>/archive`. */
export function taskRetirementDir(root: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const base = join(root, "archive");
  ensurePrivateDirectory(base);
  let directory = join(base, `task-retirement-${stamp}`);
  for (let n = 1; existsSync(directory); n++) directory = join(base, `task-retirement-${stamp}-${n}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(base);
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
  syncFile(path);
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

  for (const file of exportedFiles) syncFile(join(directory, file));
  syncDirectory(directory);
  return { directory, exportedFiles, rowCounts };
}
