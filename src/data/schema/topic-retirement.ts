import type { StorageMigration } from "../database.js";

/**
 * Retire the Topic feature (fish #19358, 2026-09-11): no migration, no export,
 * no archive — topic data is discarded outright. The only hard constraint is
 * that main chat data (room/DM messages, sequences, cursors, sessions) stays
 * untouched. Tables (`topics`, `topic_participants`, `scopes.kind='topic'`)
 * remain: no writer remains, and rebuilding the `scopes` CHECK is not worth
 * the table-copy risk.
 *
 * Every statement deletes by topic-prefixed scope key so rows are caught even
 * without their parent `scopes` row. Order is child → parent for FK safety
 * (PRAGMA foreign_keys=ON); the whole migration runs in one transaction, so a
 * failure rolls back with no half-deleted state and the upgrade aborts.
 *
 * Scope of deletion: every table carrying a `scope_id` column, plus the
 * special `token_usage_daily.room_id` usage key. Kept deliberately: historical
 * `topic_event` cards in room streams (main chat records), room attachment
 * files, background-task session files, and the `scopes.kind` CHECK value.
 */
export const topicRetirementMigration: StorageMigration = {
  id: "core-topic-retirement-v1",
  sql: `
-- Delivery chain (children before delivery_captures).
DELETE FROM queued_inputs WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_obligation_dispositions WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_settlements WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_obligations WHERE scope_id LIKE 'topic:%';
DELETE FROM captured_deliveries WHERE scope_id LIKE 'topic:%';
DELETE FROM delivery_captures WHERE scope_id LIKE 'topic:%';
-- Execution / runtime state.
DELETE FROM runtime_stale_fields WHERE scope_id LIKE 'topic:%';
DELETE FROM runtime_checkpoints WHERE scope_id LIKE 'topic:%';
DELETE FROM current_sessions WHERE scope_id LIKE 'topic:%';
DELETE FROM user_cursor_messages WHERE scope_id LIKE 'topic:%';
DELETE FROM read_cursors WHERE scope_id LIKE 'topic:%';
DELETE FROM background_tasks WHERE scope_id LIKE 'topic:%';
DELETE FROM execution_attempts WHERE scope_id LIKE 'topic:%';
-- Messages, events, statistics.
DELETE FROM message_mentions WHERE scope_id LIKE 'topic:%';
DELETE FROM message_replies WHERE scope_id LIKE 'topic:%';
DELETE FROM messages WHERE scope_id LIKE 'topic:%';
DELETE FROM message_archive_entries WHERE scope_id LIKE 'topic:%';
DELETE FROM message_archives WHERE scope_id LIKE 'topic:%';
DELETE FROM event_source_receipts WHERE event_id IN (SELECT id FROM agent_events WHERE scope_id LIKE 'topic:%');
DELETE FROM event_usage_receipts WHERE event_id IN (SELECT id FROM agent_events WHERE scope_id LIKE 'topic:%');
DELETE FROM agent_events WHERE scope_id LIKE 'topic:%';
DELETE FROM member_statistics WHERE scope_id LIKE 'topic:%';
DELETE FROM dm_member_cursor_sequences WHERE scope_id LIKE 'topic:%';
DELETE FROM token_usage_daily WHERE room_id LIKE 'topic:%';
-- Document metadata.
DELETE FROM memory_document_history WHERE scope_id LIKE 'topic:%';
DELETE FROM memory_documents WHERE scope_id LIKE 'topic:%';
-- Remaining scope-bound rows, then the topic records themselves.
DELETE FROM scope_sequences WHERE scope_id LIKE 'topic:%';
DELETE FROM outbox WHERE scope_id LIKE 'topic:%';
DELETE FROM topic_participants;
DELETE FROM topics;
DELETE FROM scopes WHERE kind='topic';
`,
};
