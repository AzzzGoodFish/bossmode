// Migration: message-seq-v1
// Backfills room-scoped monotonically increasing `seq` onto every existing message in
// each room's messages.jsonl. Idempotent: rooms where every message already has a seq
// are skipped entirely (no writes, no marker flip needed — re-derivable from data).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../../shared/config.js";
import { logger } from "../../kernel/logger.js";
import type { RoomMessage } from "../../kernel/types.js";

const MIGRATION_ID = "message-seq-v1";

function roomsRoot(): string {
  return join(getBossmodeDir(), "rooms");
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
  const target = join(snapshotDir(), `${MIGRATION_ID}-${label}-${Date.now()}.json`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(sourcePath, target);
}

export function runMessageSeqMigration(): void {
  if (!existsSync(roomsRoot())) return;
  const marker = readMarker();
  let changed = false;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    logger.error("migration", "message-seq-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    const messagesPath = join(roomsRoot(), roomId, "messages.jsonl");
    if (!existsSync(messagesPath)) continue;

    // Re-derive correctness from actual data: if every message already has a seq,
    // this room is done regardless of what the marker says (marker could have been
    // set before the room's data existed, per the member-credential-binding lesson).
    const content = readFileSync(messagesPath, "utf-8").trim();
    if (!content) continue;
    const lines = content.split("\n");
    const messages: RoomMessage[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); }
      catch { /* skip corrupt lines during one-shot migration */ }
    }
    const needsBackfill = messages.some((m) => typeof m.seq !== "number");
    if (!needsBackfill) {
      if (!marker.rooms[roomId]) {
        marker.rooms[roomId] = true;
        changed = true;
      }
      continue;
    }

    snapshotFile(messagesPath, `room-${roomId}`);

    // Assign seq in append order (the file's existing order is the canonical order).
    let seq = 1;
    const backfilled = messages.map((m) => ({ ...m, seq: seq++ }));
    writeFileSync(messagesPath, backfilled.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

    // Keep the room's next-seq counter ahead of the backfilled range.
    const seqFile = join(roomsRoot(), roomId, ".seq");
    writeFileSync(seqFile, String(seq), "utf-8");

    marker.rooms[roomId] = true;
    changed = true;
    logger.info("migration", "message-seq-v1 backfilled room", { roomId, count: backfilled.length });
  }

  if (changed) writeMarker(marker);
}
