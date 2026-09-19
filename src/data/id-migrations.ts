import { getDatabase, type Database } from "./database.js";

export interface RoomIdMigration {
  oldId: string;
  newId: string;
}

/** Exact persisted room-ID rewrites. Consumers must not infer aliases from names or paths. */
export function readRoomIdMigrations(db: Database = getDatabase()): RoomIdMigration[] {
  return db.all<{ old_id: string; new_id: string }>(
    "SELECT old_id, new_id FROM id_migration_map WHERE kind='room' ORDER BY old_id, new_id",
  ).map(row => ({ oldId: row.old_id, newId: row.new_id }));
}
