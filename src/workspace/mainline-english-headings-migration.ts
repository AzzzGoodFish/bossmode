// Migration: mainline-english-headings-v1
// Rewrites the canonical Mainline section headings from Chinese to English
// (## 焦点 -> ## Focus, ## 动态索引 -> ## Dynamic Index) inside every stored
// Mainline file, so the parser's canonical heading names and the on-disk
// content agree. Must run after memory-storage-reorg-v1 (operates on files at
// the new memory/members/<id>/mainline.md location only).
//
// Idempotent and content-safe: a file with neither Chinese heading is left
// untouched, and correctness is re-derived from actual data on every run (a
// room is only skipped once a scan finds neither heading left in any of its
// member mainline files).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir } from "./room-store.js";

const MIGRATION_ID = "mainline-english-headings-v1";

const HEADING_REWRITES: Array<[RegExp, string]> = [
  [/^## 焦点[^\S\n]*$/m, "## Focus"],
  [/^## 动态索引[^\S\n]*$/m, "## Dynamic Index"],
];

function migrationsRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}
function markerPath(): string {
  return join(migrationsRoot(), ".migrations", `${MIGRATION_ID}.json`);
}
function snapshotDir(): string {
  return join(migrationsRoot(), ".migration-snapshots");
}
interface MigrationMarker {
  rooms: Record<string, boolean>;
}
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
function readMarker(): MigrationMarker {
  const marker = readJson<Partial<MigrationMarker>>(markerPath(), {});
  return { rooms: marker.rooms || {} };
}
function writeMarker(marker: MigrationMarker): void {
  writeJson(markerPath(), { migration: MIGRATION_ID, ...marker, updatedAt: Date.now() });
}
function snapshotFile(sourcePath: string, label: string): void {
  if (!existsSync(sourcePath)) return;
  const target = join(snapshotDir(), `${MIGRATION_ID}-${label}-${Date.now()}.md`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(sourcePath, target);
}

function rewriteHeadings(content: string): string | null {
  let next = content;
  for (const [pattern, replacement] of HEADING_REWRITES) {
    next = next.replace(pattern, replacement);
  }
  return next === content ? null : next;
}

function migrateFile(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf-8");
  const rewritten = rewriteHeadings(content);
  if (rewritten === null) return false;
  snapshotFile(path, label);
  writeFileSync(path, rewritten, "utf-8");
  return true;
}

function migrateRoom(roomId: string): number {
  const membersDir = join(getRoomsDir(), roomId, "memory", "members");
  if (!existsSync(membersDir)) return 0;
  let changed = 0;
  for (const entry of readdirSync(membersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mainlinePath = join(membersDir, entry.name, "mainline.md");
    if (migrateFile(mainlinePath, `${roomId}-${entry.name}`)) changed += 1;
  }
  return changed;
}

export function runMainlineEnglishHeadingsMigration(): void {
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;
  const marker = readMarker();
  let markerChanged = false;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logger.error("migration", "mainline-english-headings-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    let changed = 0;
    try {
      changed = migrateRoom(roomId);
    } catch (err) {
      logger.error("migration", "mainline-english-headings-v1 failed to migrate room", { roomId, error: String(err) });
    }
    if (changed > 0) logger.info("migration", "mainline-english-headings-v1 rewrote room mainlines", { roomId, changed });
    if (!marker.rooms[roomId]) {
      marker.rooms[roomId] = true;
      markerChanged = true;
    }
  }

  if (markerChanged) writeMarker(marker);
}
