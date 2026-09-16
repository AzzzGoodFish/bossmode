import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../../kernel/logger.js";
import type { Database } from "../database.js";

const FLAG = "core-member-session-archive-v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEMBER_ID = /^mem_[A-Za-z0-9-]+$/;
/** Directories the member-level session layout replaced (① A2). */
const RETIRED_DIRS = new Set(["rooms", "dm"]);
/** Retired scope-keyed session reference file (pre-DB layout). */
const RETIRED_FILE = "current.json";

/**
 * Park retired per-scope session artifacts in `members/<id>/archive/sessions/`
 * (① A3, fish #20025). A member now has one session under
 * `sessions/<day>/main/`; the old `rooms/<room>` and `dm` trees — and the legacy
 * `sessions/current.json` reference file — are moved aside rather than deleted,
 * so nothing is lost and nothing resumes them. Runs after the storage upgrade
 * settles, alongside the other retirement cleanups.
 *
 * - Idempotent: a `storage_meta` flag records completion; while absent (e.g. a
 *   previous attempt failed) later startups retry, but files arriving after the
 *   flag are deliberately left in place.
 * - Non-blocking: file-only leftovers never affect chat data, so failures are
 *   logged and retried, never allowed to fail the upgrade.
 * - Narrow: only `sessions/<day>/{rooms,dm}` directories and `sessions/current.json`
 *   are matched; `sessions/<day>/main/` and everything else under the member
 *   directory stays untouched. Symlinks are never followed or moved.
 * - Never overwrites: if the archive already holds the target path it is left
 *   alone and the conflict is counted (no merge, no clobber).
 */
export function archiveRetiredScopeSessions(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", FLAG)) return;
    const membersRoot = join(root, "members");
    let moved = 0;
    let skipped = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const memberRoot = join(membersRoot, member.name);
        const sessionsRoot = join(memberRoot, "sessions");
        if (!existsSync(sessionsRoot)) continue;
        const archiveRoot = join(memberRoot, "archive", "sessions");
        for (const day of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!day.isDirectory() || !DAY.test(day.name)) continue;
          const dayDir = join(sessionsRoot, day.name);
          for (const entry of readdirSync(dayDir, { withFileTypes: true })) {
            // Real directories only: symlinks and files are never matched (or followed).
            if (!entry.isDirectory() || !RETIRED_DIRS.has(entry.name)) continue;
            const target = join(archiveRoot, day.name, entry.name);
            if (existsSync(target)) {
              skipped += 1;
              continue;
            }
            mkdirSync(dirname(target), { recursive: true });
            renameSync(join(dayDir, entry.name), target);
            moved += 1;
          }
        }
        const reference = join(sessionsRoot, RETIRED_FILE);
        if (existsSync(reference)) {
          const target = join(archiveRoot, RETIRED_FILE);
          if (existsSync(target)) skipped += 1;
          else {
            mkdirSync(dirname(target), { recursive: true });
            renameSync(reference, target);
            moved += 1;
          }
        }
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", FLAG,
      JSON.stringify({ movedEntries: moved, skippedConflicts: skipped, completedAt: Date.now() }));
    if (moved || skipped) {
      logger.info("storage-upgrade", "Retired scope session files archived", { moved, skipped });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Retired scope session archive pending (will retry next startup): ${String(error)}`);
  }
}
