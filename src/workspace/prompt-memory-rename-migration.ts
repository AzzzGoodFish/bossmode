// Migration: prompt-memory-rename-v1
// One-shot rename of the prompt-asset tool names inside stored memory markdown:
// read/edit/write_asset → read/edit/write_memory (fish renamed the umbrella term
// "asset" to "memory"). Rewrites any *_asset references members wrote into their
// principles/mainline so the content points at the live tools, and syncs each
// store's meta.json contentHash/contentLength after a rewrite.
//
// Correctness is re-derived from actual data on every run (never trusts a stale
// "done" marker): a room is only skipped when a scan finds no *_asset reference
// left, so a room wrongly marked done before its member files existed is fixed
// automatically on the next startup. Storage layout is unchanged; every changed
// file is snapshotted first.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../kernel/logger.js";
import { getRoomsDir } from "./room-store.js";
import { computeContentMeta } from "./principles-store.js";

const MIGRATION_ID = "prompt-memory-rename-v1";

const TOOL_NAME_REWRITES: Array<[RegExp, string]> = [
  [/\bread_asset\b/g, "read_memory"],
  [/\bedit_asset\b/g, "edit_memory"],
  [/\bwrite_asset\b/g, "write_memory"],
];

interface MetaLite {
  contentHash: string;
  contentLength: number;
  [key: string]: unknown;
}
interface PrinciplesMetaFileLite {
  room?: MetaLite;
  members?: Record<string, MetaLite>;
}

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

function rewriteRetiredToolNames(content: string): string | null {
  let next = content;
  for (const [pattern, replacement] of TOOL_NAME_REWRITES) {
    next = next.replace(pattern, replacement);
  }
  return next === content ? null : next;
}

function migrateContentFile(path: string, label: string): { changed: boolean; content?: string } {
  if (!existsSync(path)) return { changed: false };
  const content = readFileSync(path, "utf-8");
  const rewritten = rewriteRetiredToolNames(content);
  if (rewritten === null) return { changed: false };
  snapshotFile(path, label);
  writeFileSync(path, rewritten, "utf-8");
  return { changed: true, content: rewritten };
}

function migrateRoom(roomId: string): number {
  let changed = 0;
  const memDir = join(getRoomsDir(), roomId, "memory");
  if (!existsSync(memDir)) return 0;

  // Room-level principles (memory/room-principles.md + principles-meta.json's room entry).
  const pMetaPath = join(memDir, "principles-meta.json");
  const pMeta = readJson<PrinciplesMetaFileLite>(pMetaPath, {});
  let pMetaChanged = false;
  const roomResult = migrateContentFile(join(memDir, "room-principles.md"), `principles-${roomId}-room`);
  if (roomResult.changed && roomResult.content !== undefined) {
    changed += 1;
    if (pMeta.room) {
      pMeta.room = { ...pMeta.room, ...computeContentMeta(roomResult.content) };
      pMetaChanged = true;
    }
  }

  // Member-level: memory/members/<id>/{principles,mainline}.md, meta keyed by memberId
  // in principles-meta.json / mainline-meta.json respectively.
  const mMetaPath = join(memDir, "mainline-meta.json");
  const mMeta = readJson<PrinciplesMetaFileLite>(mMetaPath, {});
  let mMetaChanged = false;
  const membersDir = join(memDir, "members");
  if (existsSync(membersDir)) {
    for (const entry of readdirSync(membersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(membersDir, entry.name);
      const pResult = migrateContentFile(join(dir, "principles.md"), `principles-${roomId}-${entry.name}`);
      if (pResult.changed && pResult.content !== undefined) {
        changed += 1;
        if (!pMeta.members) pMeta.members = {};
        if (pMeta.members[entry.name]) {
          pMeta.members[entry.name] = { ...pMeta.members[entry.name], ...computeContentMeta(pResult.content) };
          pMetaChanged = true;
        }
      }
      const mResult = migrateContentFile(join(dir, "mainline.md"), `mainline-${roomId}-${entry.name}`);
      if (mResult.changed && mResult.content !== undefined) {
        changed += 1;
        if (!mMeta.members) mMeta.members = {};
        if (mMeta.members[entry.name]) {
          mMeta.members[entry.name] = { ...mMeta.members[entry.name], ...computeContentMeta(mResult.content) };
          mMetaChanged = true;
        }
      }
    }
  }

  if (pMetaChanged) writeJson(pMetaPath, pMeta);
  if (mMetaChanged) writeJson(mMetaPath, mMeta);
  return changed;
}

export function runPromptMemoryRenameMigration(): void {
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;
  const marker = readMarker();
  let markerChanged = false;

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
    // Re-derive correctness from data: run whenever any *_asset reference remains,
    // regardless of what the marker says. The marker only short-circuits a room
    // once its data is actually clean.
    let changed = 0;
    try {
      changed = migrateRoom(roomId);
    } catch (err) {
      logger.error("migration", "prompt-memory-rename-v1 failed to migrate room", { roomId, error: String(err) });
    }
    if (changed > 0) logger.info("migration", "prompt-memory-rename-v1 rewrote room memory", { roomId, changed });
    if (!marker.rooms[roomId]) {
      marker.rooms[roomId] = true;
      markerChanged = true;
    }
  }

  if (markerChanged) writeMarker(marker);
}
