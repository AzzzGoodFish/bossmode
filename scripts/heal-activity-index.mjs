#!/usr/bin/env node
// Standalone Activity projection gap-heal — NOT shipped in the npm package.
//
// What it does: scans each member's agent-events *.jsonl and inserts any
// INDEXED activity event seq that exists on disk but is missing from the
// projection DB (SQLite activity_events). Token rollups only run for the
// newly inserted seqs — already-indexed rows are skipped, so usage never
// double-counts. Watermarks are untouched (catch-up owns the tail).
//
// Run it when a version change added new event types to the INDEXED set and
// historical rows fell behind the watermark (the user_steer gap class).
// Idempotent: a second run heals nothing.
//
// Usage:
//   node --experimental-sqlite scripts/heal-activity-index.mjs
//   BOSSMODE_DIR=/path node --experimental-sqlite scripts/heal-activity-index.mjs
//
// Requires an existing projection DB (bossmode.db under the bossmode dir).
// If the DB is missing, start bossmode once so it creates the schema first.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const BOSSMODE_DIR = process.env.BOSSMODE_DIR || join(homedir(), ".bossmode");
const DB_PATH = join(BOSSMODE_DIR, "bossmode.db");
const ROOMS_DIR = join(BOSSMODE_DIR, "rooms");

// Must mirror src/workspace/db/activity-index.ts INDEXED_ACTIVITY_TYPES.
const INDEXED_TYPES = new Set([
  "agent_start",
  "agent_end",
  "message_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "compaction_end",
  "user_prompt",
  "user_steer",
  "system",
]);

function utcDate(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

// Replicate resolveMemberEventFiles dedup (src/workspace/db/backfill.ts):
// when a member has an id-keyed file, its legacy name-keyed file is skipped.
function resolveMemberEventFiles(roomDir) {
  const dir = join(roomDir, "agent-events");
  if (!existsSync(dir)) return { files: [], skippedNameKeyed: 0 };

  const present = new Set(
    readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".stats.json")),
  );

  let members = [];
  try {
    const room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf-8"));
    const list = Array.isArray(room.roomMembers)
      ? room.roomMembers
      : Array.isArray(room.members)
        ? room.members.map((name) => ({ id: name, name }))
        : [];
    members = list.map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
  } catch {
    members = [];
  }

  const nameKeyedToSkip = new Set();
  const chosen = [];
  const claimed = new Set();

  for (const m of members) {
    const idFile = `${m.id}.jsonl`;
    const nameFile = `${m.name}.jsonl`;
    if (present.has(idFile)) {
      chosen.push({ memberId: m.id, file: idFile });
      claimed.add(idFile);
      if (present.has(nameFile) && nameFile !== idFile) nameKeyedToSkip.add(nameFile);
    } else if (present.has(nameFile)) {
      chosen.push({ memberId: m.id, file: nameFile });
      claimed.add(nameFile);
    }
  }

  for (const f of present) {
    if (claimed.has(f) || nameKeyedToSkip.has(f)) continue;
    const stem = f.slice(0, -".jsonl".length);
    chosen.push({ memberId: stem, file: f });
    claimed.add(f);
  }

  return { files: chosen, skippedNameKeyed: nameKeyedToSkip.size };
}

function healFile(db, roomId, memberId, filePath) {
  const empty = { healed: 0, tokenRows: 0, scanned: 0 };
  if (!existsSync(filePath)) return empty;

  let existing;
  try {
    const rows = db.prepare("SELECT seq FROM activity_events WHERE room_id = ? AND member_id = ?").all(roomId, memberId);
    existing = new Set(rows.map((r) => r.seq));
  } catch (err) {
    console.error(`  [skip] ${roomId}/${memberId}: failed to load existing seqs — ${err.message}`);
    return empty;
  }

  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`  [skip] ${roomId}/${memberId}: failed to read file — ${err.message}`);
    return empty;
  }
  if (!content) return empty;

  const insertActivity = db.prepare(
    `INSERT OR REPLACE INTO activity_events (room_id, member_id, ts, seq, type, turn_id, summary, byte_offset)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertUsage = db.prepare(
    `INSERT INTO token_usage_daily (room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(room_id, member_id, date, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read = cache_read + excluded.cache_read,
       cache_write = cache_write + excluded.cache_write,
       cost = cost + excluded.cost,
       turns = turns + excluded.turns`,
  );

  let seq = 0;
  let byteOffset = 0;
  let lastTs = null;
  let healed = 0;
  let tokenRows = 0;
  let scanned = 0;
  const ops = [];

  for (const line of content.split("\n")) {
    const lineBytes = Buffer.byteLength(line, "utf-8");
    const thisOffset = byteOffset;
    byteOffset += lineBytes + 1;
    if (!line.trim()) continue;
    scanned += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate corrupt trailing line
    }
    seq += 1;
    const ts = typeof event.ts === "number" ? event.ts : (lastTs ?? 0);
    lastTs = ts;

    if (!INDEXED_TYPES.has(event.type)) continue;
    if (existing.has(seq)) continue; // already projected — skip activity + token

    // Capture loop-local values; the op runs after the scan (see ops loop below).
    const capturedSeq = seq;
    const capturedOffset = thisOffset;
    const capturedType = event.type;
    const capturedTs = ts;
    const capturedEvent = event;
    ops.push(() => insertActivity.run(roomId, memberId, capturedTs, capturedSeq, capturedType, null, null, capturedOffset));
    healed += 1;

    if (capturedEvent.type === "message_end" && capturedEvent.usage) {
      const u = capturedEvent.usage;
      const date = utcDate(capturedTs);
      const model = capturedEvent.model && String(capturedEvent.model).trim() ? capturedEvent.model : "unknown";
      ops.push(() =>
        upsertUsage.run(
          roomId,
          memberId,
          date,
          model,
          u.inputTokens || 0,
          u.outputTokens || 0,
          u.cacheRead || 0,
          u.cacheWrite || 0,
          u.cost || 0,
        ),
      );
      tokenRows += 1;
    }
  }

  if (ops.length === 0) return { healed: 0, tokenRows: 0, scanned };

  try {
    db.exec("BEGIN");
    for (const op of ops) op();
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    console.error(`  [fail] ${roomId}/${memberId}: write failed — ${err.message}`);
    return { healed: 0, tokenRows: 0, scanned };
  }

  if (healed) console.log(`  ${roomId}/${memberId}: +${healed} rows (+${tokenRows} token), scanned ${scanned}`);
  return { healed, tokenRows, scanned };
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`Projection DB not found at ${DB_PATH}. Start bossmode once so it creates the schema, then re-run.`);
    process.exit(1);
  }
  if (!existsSync(ROOMS_DIR)) {
    console.log("No rooms directory — nothing to heal.");
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  // Match the product's pragmas (openDb in src/workspace/db/sqlite.ts).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const summary = { members: 0, healed: 0, tokenRows: 0, skippedNameKeyed: 0 };
  const roomIds = readdirSync(ROOMS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  console.log(`Healing Activity projection (${roomIds.length} room${roomIds.length === 1 ? "" : "s"})...`);
  for (const roomId of roomIds) {
    const roomDir = join(ROOMS_DIR, roomId);
    const { files, skippedNameKeyed } = resolveMemberEventFiles(roomDir);
    summary.skippedNameKeyed += skippedNameKeyed;
    for (const { memberId, file } of files) {
      const r = healFile(db, roomId, memberId, join(roomDir, "agent-events", file));
      summary.members += 1;
      summary.healed += r.healed;
      summary.tokenRows += r.tokenRows;
    }
  }

  db.close();
  console.log(
    `Done. members=${summary.members}, rows healed=${summary.healed}, token rows=${summary.tokenRows}, skipped name-keyed=${summary.skippedNameKeyed}.`,
  );
  console.log("Idempotent: re-running is safe and a no-op when nothing is missing.");
}

main();
