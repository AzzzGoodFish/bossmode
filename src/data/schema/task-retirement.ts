import type { StorageMigration } from "../database.js";

/**
 * Retire the Task feature (fish #19253/#19256/#19259, 2026-09-11): the Task board,
 * its HTTP API, member tools and the `task:` mainline ref are all removed, and the
 * four task tables are dropped.
 *
 * Data safety: the export-and-verify step (src/data/migrations/task-retirement.ts) runs on
 * the upgrade staging database BEFORE applyStorageMigrations reaches this step, so
 * the task rows are archived to the runtime archive dir and checksummed first.
 * A fresh database never had the tables, so the DROPs are idempotent.
 */
export const taskRetirementMigration: StorageMigration = {
  id: "core-task-retirement-v1",
  sql: `
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS task_subscribers;
DROP TABLE IF EXISTS task_references;
DROP TABLE IF EXISTS tasks;
`,
};
