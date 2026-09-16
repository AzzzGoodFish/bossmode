// Migration: summary-removal-v1
// The summarize feature was retired in 0.19; summary messages are derived artifacts
// whose covered originals all remain in messages.jsonl (mergeWithSummaries only hid
// them at read time). Removing summary rows restores the originals in place — zero
// information loss. Idempotent: rooms without summary rows are skipped (data-driven,
// the marker is bookkeeping, not authority).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../kernel/logger.js";

const MIGRATION_ID = "summary-removal-v1";

function roomsRoot(): string {
  return join(getBossmodeDir(), "rooms");
}

function markerPath(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime", ".migrations", `${MIGRATION_ID}.json`);
}

function snapshotDir(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime", ".migration-snapshots");
}

interface MigrationMarker {
  rooms: Record<string, { removed: number; ts: number }>;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

export function runSummaryRemovalMigration(): { rooms: number; removed: number; skipped: boolean } {
  const root = roomsRoot();
  if (!existsSync(root)) return { rooms: 0, removed: 0, skipped: true };

  const marker = readJson<MigrationMarker>(markerPath(), { rooms: {} });
  let touchedRooms = 0;
  let totalRemoved = 0;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const roomId = entry.name;
    const path = join(root, roomId, "messages.jsonl");
    if (!existsSync(path)) continue;

    const content = readFileSync(path, "utf-8");
    if (!content.trim()) continue;
    const lines = content.split("\n").filter((l) => l.trim());

    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      let type: string | undefined;
      try { type = (JSON.parse(line) as { type?: string }).type; } catch { kept.push(line); continue; }
      if (type === "summary") removed++;
      else kept.push(line);
    }

    // Data-driven skip: nothing to remove (covers fresh installs, already-migrated
    // rooms, and rooms that never had summaries) regardless of marker state.
    if (removed === 0) continue;

    mkdirSync(snapshotDir(), { recursive: true });
    copyFileSync(path, join(snapshotDir(), `${roomId}-messages-${MIGRATION_ID}.jsonl`));

    writeFileSync(path, kept.join("\n") + "\n", "utf-8");
    marker.rooms[roomId] = { removed, ts: Date.now() };
    touchedRooms++;
    totalRemoved += removed;
    logger.info("server", "summary-removal-v1 room migrated", { roomId, removed });
  }

  writeJson(markerPath(), { migration: MIGRATION_ID, ...marker, updatedAt: Date.now() });
  return { rooms: touchedRooms, removed: totalRemoved, skipped: touchedRooms === 0 };
}
