import type { StorageMigration } from "../database.js";

/**
 * Retire background tasks (fish #19454/#19455): no archive — task records,
 * terminal-notification outbox rows and member-side task directories are
 * discarded. Runs after core-topic-retirement-v1 (which prunes topic-scoped
 * rows while the table still exists) and drops the table from every database;
 * no writer remains.
 *
 * The CREATE in schema/execution.ts stays only because the frozen topic
 * retirement migration references background_tasks (applied-migration
 * checksums are immutable); this migration removes it from every database.
 */
export const backgroundRetirementMigration: StorageMigration = {
  id: "core-background-retirement-v1",
  sql: `
DELETE FROM outbox WHERE kind='background.terminal';
DROP TABLE IF EXISTS background_tasks;
`,
};
