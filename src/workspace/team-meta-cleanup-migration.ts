// Migration: team-meta-cleanup-v1
// The Built-in Updates feature (check/apply/dismiss for out-of-date builtin
// agents/skills/rules) was retired. Its only on-disk artifact was
// ~/.bossmode/team-meta.json — nothing reads it anymore (seedBuiltinAssets
// is meta-free). One-time, idempotent removal so installs don't carry a
// dead tracking file forever.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";

const MIGRATION_ID = "team-meta-cleanup-v1";

function markerPath(): string {
  return join(getBossmodeDir(), ".migrations", `${MIGRATION_ID}.json`);
}

function alreadyDone(): boolean {
  return existsSync(markerPath());
}

function markDone(): void {
  mkdirSync(join(getBossmodeDir(), ".migrations"), { recursive: true });
  writeFileSync(markerPath(), JSON.stringify({ migration: MIGRATION_ID, updatedAt: Date.now() }, null, 2), "utf-8");
}

export function runTeamMetaCleanupMigration(): void {
  if (alreadyDone()) return;

  const metaPath = join(getBossmodeDir(), "team-meta.json");
  if (existsSync(metaPath)) {
    try {
      rmSync(metaPath, { force: true });
      logger.info("migration", "team-meta-cleanup-v1 removed dead team-meta.json");
    } catch (err) {
      logger.error("migration", "team-meta-cleanup-v1 failed to remove team-meta.json", { error: String(err) });
      return; // retry next boot rather than mark done
    }
  }

  markDone();
}
