import type { Database } from "../../src/storage/database.js";

/**
 * Short-id migration (batch 5) re-keys members/rooms on first startup. Tests that
 * seed legacy assets before the first `prepareCoreStorage` call must resolve the
 * current id afterwards; these helpers read the durable old→new mapping.
 */
export function migratedMemberId(db: Database, seedId: string): string {
  return db.get<{ new_id: string }>("SELECT new_id FROM id_migration_map WHERE kind='member' AND old_id=?", seedId)?.new_id ?? seedId;
}

export function migratedRoomId(db: Database, seedId: string): string {
  return db.get<{ new_id: string }>("SELECT new_id FROM id_migration_map WHERE kind='room' AND old_id=?", seedId)?.new_id ?? seedId;
}
