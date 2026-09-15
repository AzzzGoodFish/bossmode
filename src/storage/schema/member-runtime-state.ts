import type { StorageMigration } from "../database.js";

/**
 * Member-level runtime state (① B8 / C3, 2026-09-15): with one runtime per
 * member, `runtime_checkpoints` / `runtime_stale_fields` are keyed by member
 * alone. Per-scope rows collapse to the member's latest checkpoint; stale
 * fields union across the member's scopes (any scope's stale marker means the
 * member needs a reload), and stale_since keeps the newest marker.
 *
 * No other table references these two tables (verified), so drop/recreate is
 * safe under `PRAGMA foreign_keys=ON` (child dropped before parent).
 */
export const memberRuntimeStateMigration: StorageMigration = {
  id: "core-member-runtime-state-v1",
  sql: `
CREATE TABLE runtime_checkpoints_member (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  contract_fingerprint TEXT,
  contract_version INTEGER,
  drift_notified INTEGER,
  stale_since INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO runtime_checkpoints_member(member_id, contract_fingerprint, contract_version, drift_notified, stale_since, updated_at)
SELECT r.member_id, r.contract_fingerprint, r.contract_version, r.drift_notified,
  (SELECT MAX(r3.stale_since) FROM runtime_checkpoints r3 WHERE r3.member_id = r.member_id),
  r.updated_at
FROM runtime_checkpoints r
WHERE r.rowid = (SELECT r2.rowid FROM runtime_checkpoints r2 WHERE r2.member_id = r.member_id ORDER BY r2.updated_at DESC, r2.rowid DESC LIMIT 1);
CREATE TABLE runtime_stale_fields_member (
  member_id TEXT NOT NULL,
  field TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(member_id, field),
  FOREIGN KEY(member_id) REFERENCES runtime_checkpoints_member(member_id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO runtime_stale_fields_member(member_id, field, ordinal)
SELECT member_id, field, MIN(ordinal) FROM runtime_stale_fields GROUP BY member_id, field;
DROP TABLE runtime_stale_fields;
DROP TABLE runtime_checkpoints;
ALTER TABLE runtime_checkpoints_member RENAME TO runtime_checkpoints;
ALTER TABLE runtime_stale_fields_member RENAME TO runtime_stale_fields;
`,
};
