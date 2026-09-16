// Startup-only read-only guards. Neither files nor historical journals can replace SQL identity.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { managedPath, requireRegularFile } from "./upgrade-files.js";
import type { Database } from "./database.js";
import { MemberArchivesRepository, validateArchivePath } from "./repositories/member-archives.js";

/** Any historical conversion journal can indicate lost authority, regardless of status or syntax.
 * Do not parse it into permission to create a new, empty database. Preserve the evidence. */
export function assertNoMissingMemberDatabase(root: string): void {
  if (existsSync(managedPath(root, "bossmode.db"))) return;
  const journal = managedPath(root, "migrations/member-storage-v1.json");
  if (existsSync(journal)) throw new Error("Historical member-storage journal exists but the authoritative database is missing; no source was replaced");
}

/** Only for file-authoritative input, after parsing identity records. Empty/unknown asset
 * subtrees count too; discovery of recognized files alone cannot detect these orphans. */
export function assertLegacyMemberDirectories(root: string, memberIds: ReadonlySet<string>): void {
  const directory = managedPath(root, "members");
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory()) throw new Error("Member assets root is not a directory");
  for (const id of readdirSync(directory)) {
    const path = managedPath(root, `members/${id}`);
    if (lstatSync(path).isDirectory() && !memberIds.has(id)) {
      throw new Error(`Member assets have no identity metadata: members/${id}`);
    }
  }
}

/** Current SQL identity and document ownership must have a regular persona asset.
 * No content/hash comparison: legitimate current body edits remain authoritative.
 * Tombstones intentionally have no live directory. Pending archives are not active:
 * verify their recorded directory identity so activation can finish existing recovery. */
export function verifyActiveMemberAssets(root: string, db: Database): void {
  db.assertOutsideTransaction();
  const archives = new MemberArchivesRepository(db);
  for (const { id } of db.all<{ id: string }>("SELECT id FROM members WHERE archived_at IS NULL")) {
    const path = `members/${id}/persona.md`;
    if (!db.get("SELECT 1 FROM memory_documents WHERE path=? AND member_id=? AND layer='persona' AND scope_id IS NULL", path, id)) {
      throw new Error(`Member persona metadata missing: ${id}`);
    }
    const intent = archives.intent(id);
    let assetPath = path;
    if (intent?.state === "pending") {
      // Archive movement precedes its SQL completion. Only the explicit SQL intent,
      // exact source path and original directory device/inode authorize this location.
      // Verification never reads stale legacy bodies or copies assets back.
      validateArchivePath(intent.archivePath);
      if (intent.sourcePath !== `members/${id}`) throw new Error(`Pending archive source conflict: ${id}`);
      const source = lstatSync(managedPath(root, intent.sourcePath), { throwIfNoEntry: false });
      const destination = lstatSync(managedPath(root, intent.archivePath), { throwIfNoEntry: false });
      const location = source ?? destination;
      if ((source && destination) || !location?.isDirectory() || String(location.dev) !== intent.sourceDevice || String(location.ino) !== intent.sourceInode) {
        throw new Error(`Pending archive asset identity conflict: ${id}`);
      }
      assetPath = `${source ? intent.sourcePath : intent.archivePath}/persona.md`;
    }
    try { requireRegularFile(managedPath(root, assetPath)); }
    catch { throw new Error(`Active member persona asset missing or unsafe: ${id}; no legacy body was restored`); }
  }
}
