import type { StorageMigration } from "../database.js";

/**
 * Member-level sessions (fish #20017 / ① A1–A3, 2026-09-14): a member has
 * exactly ONE session across all chats, so `current_sessions` is keyed by
 * member alone (the old (member_id, scope_id) rows are not carried over).
 *
 * Old per-scope session files are moved into `members/<id>/archive/` by the
 * upgrade path (A3) and the member starts from an empty session — the new
 * shape begins with zero rows. `runtime_checkpoints` / `runtime_stale_fields`
 * stay scope-keyed in this migration; their member-level reshape lands with the
 * runtime slice (B8 / C3).
 *
 * No table references `current_sessions` by foreign key (verified), so the
 * drop/recreate is safe under `PRAGMA foreign_keys=ON`.
 */
export const memberSessionsMigration: StorageMigration = {
  id: "core-member-session-v1",
  sql: `
DROP TABLE current_sessions;
CREATE TABLE current_sessions (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  runtime TEXT NOT NULL CHECK(length(runtime)>0),
  sdk_session_id TEXT,
  file_reference TEXT,
  reference_kind TEXT NOT NULL CHECK(reference_kind IN ('member-relative','legacy-absolute')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
};
