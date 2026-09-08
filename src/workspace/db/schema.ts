// Schema and migration bookkeeping for durable member storage and rebuildable indexes.
//
// Migrations are append-only and idempotent: each has a stable id recorded in
// schema_migrations. runMigrations applies any not-yet-applied migrations in
// order. Member rows are authoritative and must never be removed by index rebuilds.
import type { BossmodeDb } from "./sqlite.js";
import { logger } from "../../foundation/logger.js";

interface Migration {
  id: string;
  up: string;
}

// v1 schema per docs/bossmode/architecture/plan-sqlite-usage-performance-v0191.md
const MIGRATIONS: Migration[] = [
  {
    id: "sqlite-projection-v1",
    up: `
CREATE TABLE IF NOT EXISTS token_usage_daily (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member_id, date, model)
);
CREATE INDEX IF NOT EXISTS idx_token_daily_room_date ON token_usage_daily(room_id, date);
CREATE INDEX IF NOT EXISTS idx_token_daily_room_model ON token_usage_daily(room_id, model);

CREATE TABLE IF NOT EXISTS activity_events (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  summary TEXT,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_activity_member_ts ON activity_events(room_id, member_id, ts DESC);

CREATE TABLE IF NOT EXISTS tasks (
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  assignee TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  payload_json TEXT,
  PRIMARY KEY (room_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_room_status ON tasks(room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_room_assignee ON tasks(room_id, assignee, updated_at DESC);

CREATE TABLE IF NOT EXISTS ingest_watermark (
  kind TEXT NOT NULL,
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  last_ts INTEGER,
  last_seq INTEGER,
  last_mtime_ms INTEGER,
  PRIMARY KEY (kind, room_id, member_id)
);
`,
  },
  {
    id: "member-storage-v1",
    up: `
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  title TEXT,
  agent_template TEXT NOT NULL,
  global_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE projection_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];

function ensureBookkeeping(db: BossmodeDb): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);`);
}

function appliedIds(db: BossmodeDb): Set<string> {
  const rows = db.all<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((r) => r.id));
}

/** Apply all not-yet-applied migrations in order. Idempotent. */
export function runMigrations(db: BossmodeDb): void {
  ensureBookkeeping(db);
  const applied = appliedIds(db);
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction((tx) => {
      tx.exec(m.up);
      // The old release treated an existing projection DB as initialized. Keep
      // its data; adding authoritative members must not trigger a destructive
      // startup rebuild. A genuinely new DB has no pre-existing migration ID.
      if (m.id === "member-storage-v1" && applied.has("sqlite-projection-v1")) {
        tx.run("INSERT INTO projection_state (key, value) VALUES (?, ?)", "backfill-complete", String(Date.now()));
      }
      tx.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
    });
    logger.info("db", "applied migration", { id: m.id });
  }
}

/** All known migration ids (for tests / diagnostics). */
export function migrationIds(): string[] {
  return MIGRATIONS.map((m) => m.id);
}
