// Migration: prompt-assets-rename-v1
// One-shot rename supplement → Principles/Mainline (plan §5: no dual-name fallback).
// Rewrites references to the retired tool names (read/edit/write_prompt_supplement
// → read/edit/write_asset) inside existing principles markdown so member-authored
// content points at the live tools. Storage layout (prompt-supplements/) is unchanged.
// Idempotent per room (marker) and content-safe (no old names ⇒ no writes); every
// changed file is snapshotted first.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../kernel/logger.js";
import { getRoomsDir } from "./room-store.js";

const MIGRATION_ID = "prompt-assets-rename-v1";

const TOOL_NAME_REWRITES: Array<[RegExp, string]> = [
  [/\bread_prompt_supplement\b/g, "read_asset"],
  [/\bedit_prompt_supplement\b/g, "edit_asset"],
  [/\bwrite_prompt_supplement\b/g, "write_asset"],
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

interface PrinciplesMetaLite {
  revision: number;
  contentHash: string;
  contentLength: number;
  [key: string]: unknown;
}

interface PrinciplesMetaFileLite {
  room?: PrinciplesMetaLite;
  members?: Record<string, PrinciplesMetaLite>;
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

function safeMemberId(memberId: string): string {
  return memberId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Rewrite retired tool names. Returns null when nothing needs changing. */
export function rewriteRetiredToolNames(content: string): string | null {
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
  const dir = join(getRoomsDir(), roomId, "prompt-supplements");
  if (!existsSync(dir)) return 0;
  const metaPath = join(dir, "meta.json");
  const meta = readJson<PrinciplesMetaFileLite>(metaPath, {});
  let metaChanged = false;
  let changed = 0;

  const roomResult = migrateContentFile(join(dir, "room.md"), `room-${roomId}-room`);
  if (roomResult.changed) {
    changed += 1;
    if (meta.room && roomResult.content !== undefined) {
      meta.room = { ...meta.room, contentHash: hashContent(roomResult.content), contentLength: roomResult.content.length };
      metaChanged = true;
    }
  }

  const memberIds = Object.keys(meta.members || {});
  const coveredFiles = new Set<string>();
  for (const memberId of memberIds) {
    const file = `${safeMemberId(memberId)}.md`;
    coveredFiles.add(file);
    const result = migrateContentFile(join(dir, "members", file), `room-${roomId}-member-${safeMemberId(memberId)}`);
    if (result.changed) {
      changed += 1;
      if (result.content !== undefined) {
        meta.members![memberId] = { ...meta.members![memberId], contentHash: hashContent(result.content), contentLength: result.content.length };
        metaChanged = true;
      }
    }
  }

  // Orphan member files without a meta entry still get their content rewritten.
  const membersDir = join(dir, "members");
  if (existsSync(membersDir)) {
    for (const file of readdirSync(membersDir)) {
      if (!file.endsWith(".md") || coveredFiles.has(file)) continue;
      if (migrateContentFile(join(membersDir, file), `room-${roomId}-member-${file.replace(/\.md$/, "")}`).changed) changed += 1;
    }
  }

  if (metaChanged) writeJson(metaPath, meta);
  return changed;
}

export function runPromptAssetsRenameMigration(): void {
  const marker = readMarker();
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;

  for (const entry of readdirSync(roomsDir)) {
    if (marker.rooms[entry] === true) continue;
    try {
      const changed = migrateRoom(entry);
      if (changed > 0) logger.info("prompt-assets-rename-migration", "rewrote retired supplement tool names", { roomId: entry, changed });
    } catch (err) {
      logger.error("prompt-assets-rename-migration", "failed to migrate room", { roomId: entry, error: String(err) });
    }
    marker.rooms[entry] = true;
    writeMarker(marker);
  }
}
