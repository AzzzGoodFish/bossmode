import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { logger } from "../foundation/logger.js";
import type { Database } from "./database.js";

const SHARED_FLAG = "core-global-archive-v1";
const SCOPES_FLAG = "core-member-memory-scopes-v1";
const MEMBER_ID = /^mem_[A-Za-z0-9-]+$/;

/** Recursively list files (relative, POSIX-ish) without following symlinks. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) out.push(relative(root, absolute).split("\\").join("/"));
      // Symlinks are deliberately neither followed nor listed.
    }
  };
  walk(root);
  return out;
}

function removeIfEmpty(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir); // rmSync(..., {recursive:false}) rejects directories (EISDIR)
    return true;
  } catch {
    return false;
  }
}

/**
 * ④ A (fish #20035): the legacy shared memory (`memory/user`, `memory/projects`)
 * is retired with the member-private memory model. On upgrade the content moves
 * to the workspace-level global archive (`<root>/archive/memory/<source>`) —
 * read-only history, nothing deleted, nothing merged: if the archive target
 * already exists the source is left in place and the conflict is counted.
 * Idempotent via a `storage_meta` flag; failures are logged and retried next
 * start (matches the other post-upgrade file cleanups).
 */
export function archiveLegacySharedMemory(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", SHARED_FLAG)) return;
    const archiveRoot = join(root, "archive");
    const sources: Array<{ from: string; to: string }> = [
      { from: join(root, "memory", "user"), to: join(archiveRoot, "memory", "user") },
      { from: join(root, "memory", "projects"), to: join(archiveRoot, "memory", "projects") },
    ];
    let moved = 0;
    let skipped = 0;
    let cleaned = 0;
    for (const { from, to } of sources) {
      if (!existsSync(from)) continue;
      if (listFiles(from).length === 0) {
        // Empty shells carry nothing to preserve — tidy them away.
        if (removeIfEmpty(from)) cleaned += 1;
        else skipped += 1;
        continue;
      }
      if (existsSync(to)) {
        skipped += 1; // never merge or clobber; leave the source for a human to inspect
        continue;
      }
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      moved += 1;
    }
    removeIfEmpty(join(root, "memory"));
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SHARED_FLAG,
      JSON.stringify({ movedRoots: moved, skippedConflicts: skipped, cleanedEmpty: cleaned, completedAt: Date.now() }));
    if (moved || skipped || cleaned) {
      logger.info("storage-upgrade", "Legacy shared memory archived to global archive", { moved, skipped, cleaned, archiveRoot });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Legacy shared memory archive pending (will retry next startup): ${String(error)}`);
  }
}

/**
 * ④ B (fish #20035): `memory/scopes/` was the retired per-chat memory layout.
 * Fold any remaining files into the member's overview+parts root as
 * `scopes-<path-with-dashes>.md` (nothing lost, deterministic names), then drop
 * the empty tree. A member with an empty `scopes/` just gets the tree removed.
 * Idempotent via a `storage_meta` flag; non-blocking on failure.
 */
export function cleanupMemberMemoryScopes(root: string, db: Database): void {
  try {
    if (db.get("SELECT 1 FROM storage_meta WHERE key=?", SCOPES_FLAG)) return;
    const membersRoot = join(root, "members");
    let folded = 0;
    let cleaned = 0;
    let skipped = 0;
    if (existsSync(membersRoot)) {
      for (const member of readdirSync(membersRoot, { withFileTypes: true })) {
        if (!member.isDirectory() || !MEMBER_ID.test(member.name)) continue;
        const memoryRoot = join(membersRoot, member.name, "memory");
        const scopesRoot = join(memoryRoot, "scopes");
        if (!existsSync(scopesRoot)) continue;
        const files = listFiles(scopesRoot);
        if (files.length === 0) {
          if (removeIfEmpty(scopesRoot)) cleaned += 1;
          continue;
        }
        for (const rel of files) {
          const target = join(memoryRoot, `scopes-${rel.replace(/\//g, "-")}`);
          if (existsSync(target)) {
            skipped += 1;
            continue;
          }
          mkdirSync(dirname(target), { recursive: true });
          renameSync(join(scopesRoot, rel), target);
          folded += 1;
        }
        // Remove the tree if every file moved out (leftovers stay on conflict).
        if (listFiles(scopesRoot).length === 0) rmSync(scopesRoot, { recursive: true });
      }
    }
    db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", SCOPES_FLAG,
      JSON.stringify({ foldedFiles: folded, cleanedEmpty: cleaned, skippedConflicts: skipped, completedAt: Date.now() }));
    if (folded || cleaned || skipped) {
      logger.info("storage-upgrade", "Member memory/scopes folded into the member memory root", { folded, cleaned, skipped });
    }
  } catch (error) {
    logger.warn("storage-upgrade",
      `Member memory scopes fold pending (will retry next startup): ${String(error)}`);
  }
}
