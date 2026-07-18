// Migration: memory-storage-reorg-v1
// Moves member memory storage from the legacy split layout
// (prompt-supplements/ for Principles, mainlines/ for Mainline) into a single
// unified domain directory: rooms/<roomId>/memory/, with each member getting
// one subdirectory holding both of its files (principles.md + mainline.md).
//
// This is a copy-forward, not a delete: legacy files are left in place (they
// become inert once the store code only reads/writes the new paths) so this
// migration is trivially safe to re-run. Correctness is re-derived from actual
// data on every run — a room is only skipped once every legacy file it has has
// a corresponding file at the new location; a partially-migrated room (e.g. a
// member file added to the old location after an earlier run, or a run that
// was interrupted) is completed on the next startup regardless of any marker.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir } from "./room-store.js";

const MIGRATION_ID = "memory-storage-reorg-v1";

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
  const target = join(snapshotDir(), `${MIGRATION_ID}-${label}-${Date.now()}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(sourcePath, target);
}

/** Copy source -> target if target does not already exist. Snapshots the
 * source first (harmless — source is left in place either way). Returns
 * whether a copy happened. */
function copyIfMissing(source: string, target: string, label: string): boolean {
  if (!existsSync(source) || existsSync(target)) return false;
  snapshotFile(source, label);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

function migrateRoom(roomId: string): number {
  const roomDir = join(getRoomsDir(), roomId);
  const oldPrincipalsDir = join(roomDir, "prompt-supplements");
  const oldMainlinesDir = join(roomDir, "mainlines");
  const newMemoryDir = join(roomDir, "memory");
  const newMembersDir = join(newMemoryDir, "members");
  let changed = 0;

  // Room-level principles + meta/history (no per-member split).
  if (copyIfMissing(join(oldPrincipalsDir, "room.md"), join(newMemoryDir, "room-principles.md"), `${roomId}-room-principles`)) changed += 1;
  if (copyIfMissing(join(oldPrincipalsDir, "meta.json"), join(newMemoryDir, "principles-meta.json"), `${roomId}-principles-meta`)) changed += 1;
  if (copyIfMissing(join(oldPrincipalsDir, "history.jsonl"), join(newMemoryDir, "principles-history.jsonl"), `${roomId}-principles-history`)) changed += 1;
  if (copyIfMissing(join(oldMainlinesDir, "meta.json"), join(newMemoryDir, "mainline-meta.json"), `${roomId}-mainline-meta`)) changed += 1;
  if (copyIfMissing(join(oldMainlinesDir, "history.jsonl"), join(newMemoryDir, "mainline-history.jsonl"), `${roomId}-mainline-history`)) changed += 1;

  // Member-level: prompt-supplements/members/<id>.md + mainlines/members/<id>.md
  // -> memory/members/<id>/{principles,mainline}.md. Enumerate both legacy
  // member directories since a member could have one asset without the other.
  const memberIds = new Set<string>();
  for (const [dir] of [[join(oldPrincipalsDir, "members")]] as const) {
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".md")) memberIds.add(f.replace(/\.md$/, ""));
  }
  if (existsSync(join(oldMainlinesDir, "members"))) {
    for (const f of readdirSync(join(oldMainlinesDir, "members"))) if (f.endsWith(".md")) memberIds.add(f.replace(/\.md$/, ""));
  }

  for (const memberFile of memberIds) {
    const target = join(newMembersDir, memberFile);
    if (copyIfMissing(join(oldPrincipalsDir, "members", `${memberFile}.md`), join(target, "principles.md"), `${roomId}-member-${memberFile}-principles`)) changed += 1;
    if (copyIfMissing(join(oldMainlinesDir, "members", `${memberFile}.md`), join(target, "mainline.md"), `${roomId}-member-${memberFile}-mainline`)) changed += 1;
  }

  return changed;
}

export function runMemoryStorageReorgMigration(): void {
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;
  const marker = readMarker();
  let markerChanged = false;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logger.error("migration", "memory-storage-reorg-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    let changed = 0;
    try {
      changed = migrateRoom(roomId);
    } catch (err) {
      logger.error("migration", "memory-storage-reorg-v1 failed to migrate room", { roomId, error: String(err) });
    }
    if (changed > 0) logger.info("migration", "memory-storage-reorg-v1 migrated room", { roomId, changed });
    if (!marker.rooms[roomId]) {
      marker.rooms[roomId] = true;
      markerChanged = true;
    }
  }

  if (markerChanged) writeMarker(marker);
}
