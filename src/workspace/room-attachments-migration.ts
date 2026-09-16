/**
 * Batch 7 P3 (spec §5): room attachments move from the legacy
 * `<room.cwd>/.bossmode-attachments` into the room's own data directory
 * (`~/.bossmode/rooms/<id>/attachments`). Startup-applied, idempotent,
 * never blocking listen. Message metadata stores filenames only, so moved
 * files keep serving through the new location — history stays intact.
 */
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as roomStore from "../chat/room-store.js";
import { roomDir } from "../files/layout.js";

export interface RoomAttachmentsMigrationReport {
  ran: boolean;
  movedRooms: string[];
  skipped: string[];
}

const LEGACY_DIR_NAME = ".bossmode-attachments";

export function needsRoomAttachmentsMigration(): boolean {
  for (const room of roomStore.listRooms()) {
    if (!room.cwd) continue;
    const legacy = join(room.cwd, LEGACY_DIR_NAME);
    const target = join(roomDir(room.id), "attachments");
    if (existsSync(legacy) && !existsSync(target)) return true;
  }
  return false;
}

export function runRoomAttachmentsMigration(): RoomAttachmentsMigrationReport {
  const report: RoomAttachmentsMigrationReport = { ran: true, movedRooms: [], skipped: [] };
  for (const room of roomStore.listRooms()) {
    if (!room.cwd) continue;
    const legacy = join(room.cwd, LEGACY_DIR_NAME);
    const target = join(roomDir(room.id), "attachments");
    if (!existsSync(legacy)) continue;
    if (existsSync(target)) {
      // Target already exists (previous run or fresh room) — leave legacy
      // files untouched; the new store only reads the new location.
      report.skipped.push(room.id);
      continue;
    }
    try {
      renameSync(legacy, target);
      report.movedRooms.push(room.id);
    } catch {
      // Cross-device rename: move file-by-file.
      try {
        const { mkdirSync, copyFileSync } = require("node:fs") as typeof import("node:fs");
        mkdirSync(target, { recursive: true });
        for (const name of readdirSync(legacy)) {
          copyFileSync(join(legacy, name), join(target, name));
        }
        rmSync(legacy, { recursive: true, force: true });
        report.movedRooms.push(room.id);
      } catch {
        report.skipped.push(room.id);
      }
    }
  }
  return report;
}

/** Daemon startup hook: apply once, silently, never blocking listen. */
export function runRoomAttachmentsMigrationOnStartup(): void {
  try {
    if (!needsRoomAttachmentsMigration()) return;
    const report = runRoomAttachmentsMigration();
    if (report.movedRooms.length > 0) {
      console.log(`[room-attachments-migration] moved ${report.movedRooms.length} room attachment dir(s) into room data directories`);
    }
  } catch (err) {
    console.error(`[room-attachments-migration] failed (non-fatal):`, err);
  }
}
