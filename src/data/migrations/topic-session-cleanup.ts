import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../kernel/logger.js";
import type { Database } from "../database.js";

const FLAG = "core-topic-session-cleanup-v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEMBER_ID = /^mem_[A-Za-z0-9-]+$/;

/**
 * Delete retired topic session directories from member session trees (topic
 * retirement §3.4, fish #19358). Runs after the storage upgrade settles.
 *
 * - Idempotent: a storage_meta flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry.
 * - Non-blocking: file-only leftovers never affect main chat data, so failures
 *   are logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `<member>/sessions/<day>/topics/…` and legacy `topic-…`
 *   prefixed directories inside session day trees are matched; room/DM session
 *   files and the `sessions/current.json` reference file are never touched.
 */
export function cleanupRetiredTopicSessionFiles(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", FLAG)) return;
    const membersRoot = join(root, "members");
    let removed = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const sessionsRoot = join(membersRoot, member.name, "sessions");
        if (!existsSync(sessionsRoot)) continue;
        for (const day of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!day.isDirectory() || !DAY.test(day.name)) continue;
          const dayDir = join(sessionsRoot, day.name);
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            // Real directories only: symlinks and files are never matched (or followed).
            if (!entry.isDirectory()) continue;
            if (entry.name !== "topics" && !entry.name.startsWith("topic-")) continue;
            rmSync(join(dayDir, entry.name), { recursive: true, force: true });
            removed += 1;
          }
        }
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", FLAG,
      JSON.stringify({ removedDirectories: removed, completedAt: Date.now() }));
    if (removed) logger.info("storage-upgrade", "Retired topic session directories removed", { removed });
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired topic session cleanup pending (will retry next startup): ${String(error)}`);
  }
}
