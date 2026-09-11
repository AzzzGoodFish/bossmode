import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import type { Database } from "./database.js";

const FLAG = "core-background-session-cleanup-v1";
const MEMBER_ID = /^mem_[A-Za-z0-9-]+$/;

/**
 * Delete retired background-task directories from member trees (background
 * retirement, fish #19454). Runs after the storage upgrade settles.
 *
 * - Idempotent: a storage_meta flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry.
 * - Non-blocking: file-only leftovers never affect main chat data, so failures
 *   are logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `<member>/background-tasks/…` is matched; member session
 *   files, room/DM session trees and `sessions/current.json` are never
 *   touched. (Topic-scoped background children wrote into the same tree before
 *   their own retirement, so this also clears those residuals.)
 */
export function cleanupRetiredBackgroundSessionFiles(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", FLAG)) return;
    const membersRoot = join(root, "members");
    let removed = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const dir = join(membersRoot, member.name, "background-tasks");
        if (!existsSync(dir)) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", FLAG,
      JSON.stringify({ removedDirectories: removed, completedAt: Date.now() }));
    if (removed) logger.info("storage-upgrade", "Retired background task directories removed", { removed });
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired background session cleanup pending (will retry next startup): ${String(error)}`);
  }
}
