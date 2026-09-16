import { coreStorageMigrations } from "../../src/data/schema.js";

/** Test a historical schema boundary by its stable migration ID, not its old file. */
export function getMigration(id: string) {
  const migration = coreStorageMigrations.find(m => m.id === id);
  if (!migration) throw new Error(`Unknown migration: ${id}`);
  return migration;
}
