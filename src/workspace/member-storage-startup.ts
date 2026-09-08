import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { getDbPath, openDb } from "./db/sqlite.js";

/** Required identity storage check, before any registry consumer or optional migration. */
export function ensureMemberStorageReady(): void {
  const root = getBossmodeDir();
  const journal = join(root, "migrations", "member-storage-v1.json");
  if (existsSync(journal)) {
    const state = JSON.parse(readFileSync(journal, "utf8"));
    if (state.status !== "done") {
      throw new Error("Member storage migration is incomplete. Keep Bossmode stopped and recover the migration before starting.");
    }
    if (!existsSync(getDbPath())) throw new Error("Authoritative member database is missing after migration. Restore a verified database backup; do not rebuild it from retired files.");
  }
  const membersRoot = join(root, "members");
  const ids = existsSync(membersRoot)
    ? readdirSync(membersRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("mem_")).map((entry) => entry.name)
    : [];
  for (const id of ids) {
    if (["member.json", "member.md"].some((file) => existsSync(join(membersRoot, id, file)))) {
      throw new Error("Legacy member files require offline migration. Stop Bossmode, review migrate-member-storage-v1.mjs --dry-run, then apply the approved migration before starting.");
    }
  }
  if (ids.length && !existsSync(getDbPath())) {
    throw new Error("Member assets exist but the authoritative database is missing. Restore the database; refusing to start with an empty registry.");
  }
  const db = openDb(); // identity storage is mandatory; never use projection's best-effort path
  for (const row of db.all<{ id: string }>("SELECT id FROM members")) {
    if (!ids.includes(row.id)) throw new Error(`Database member has no asset directory: ${row.id}. Restore its assets before starting.`);
  }
  for (const id of ids) {
    if (!db.get("SELECT id FROM members WHERE id = ?", id)) {
      throw new Error(`Member asset directory has no database identity: ${id}. Resolve the inconsistency before starting.`);
    }
  }
}
