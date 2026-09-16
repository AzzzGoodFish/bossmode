import type { StorageMigration } from "../database.js";

/**
 * Short-id migration (batch 5): durable old→new mapping produced by the
 * `core-short-ids-v1` startup data step (src/data/migrations/short-id-migration.ts).
 * The table is populated inside the rewrite transaction; afterwards it is
 * read-only history — old ids kept in historical records resolve through it.
 */
export const shortIdsMigration: StorageMigration = {
  id: "core-short-ids-v1",
  sql: `
CREATE TABLE id_migration_map (
  kind TEXT NOT NULL CHECK (kind IN ('member', 'room')),
  old_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (kind, old_id),
  UNIQUE (kind, new_id)
);
`,
};
