// Migration: prompt-memory-rename-v1
// One-shot rename of the prompt-asset tool names inside stored memory markdown:
// read/edit/write_asset → read/edit/write_memory (fish renamed the umbrella term
// "asset" to "memory"). Rewrites any *_asset references members wrote into their
// principles/mainline so the content points at the live tools. Storage layout is
// unchanged. Idempotent per room (marker) and content-safe (no old names ⇒ no
// writes); every changed file is snapshotted first.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir } from "./room-store.js";

const MIGRATION_ID = "prompt-memory-rename-v1";

const TOOL_NAME_REWRITES: Array<[RegExp, string]> = [
  [/\bread_asset\b/g, "read_memory"],
  [/\bedit_asset\b/g, "edit_memory"],
  [/\bwrite_asset\b/g, "write_memory"],
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

function rewriteMemoryFile(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  const original = readFileSync(path, "utf-8");
  let next = original;
  for (const [pattern, replacement] of TOOL_NAME_REWRITES) {
    next = next.replace(pattern, replacement);
  }
  if (next === original) return false;
  snapshotFile(path, label);
  writeFileSync(path, next, "utf-8");
  return true;
}

export function runPromptMemoryRenameMigration(): void {
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;
  const marker = readMarker();
  let changed = false;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    logger.error("migration", "prompt-memory-rename-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    const principlesDir = join(roomsDir, roomId, "prompt-supplements");
    const mainlinesDir = join(roomsDir, roomId, "mainlines");
    let roomChanged = false;

    if (existsSync(principlesDir)) {
      for (const entry of readdirSync(principlesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (rewriteMemoryFile(join(principlesDir, entry.name), `principles-${roomId}-${entry.name}`)) roomChanged = true;
      }
    }
    if (existsSync(mainlinesDir)) {
      for (const entry of readdirSync(mainlinesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (rewriteMemoryFile(join(mainlinesDir, entry.name), `mainline-${roomId}-${entry.name}`)) roomChanged = true;
      }
    }

    if (roomChanged || !marker.rooms[roomId]) {
      marker.rooms[roomId] = true;
      changed = true;
      if (roomChanged) logger.info("migration", "prompt-memory-rename-v1 rewrote room memory", { roomId });
    }
  }

  if (changed) writeMarker(marker);
}
