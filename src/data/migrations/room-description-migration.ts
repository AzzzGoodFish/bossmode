import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../kernel/logger.js";
import type { Database } from "./database.js";

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
