import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { cleanupRetiredTopicSessionFiles } from "../../src/app/upgrade/retirements.js";
import {  } from "../../src/member/sessions.js";
import { importMessage, importMessageNextSequence } from "../../src/data/repositories/message-repository.js";
import { importAgentEvent } from "../../src/data/repositories/event-repository.js";

// Topic feature retirement (fish #19358): direct delete, no migration/export/archive.
// These assertions lock the safety properties: every topic-owned row is gone,
// main chat data is value-identical, FK checks stay clean, failures roll back with
// no half-delete, and re-application is a no-op.

let root: string;
let db: Database | undefined;
const withoutRetirement = () => coreStorageMigrations.slice(
  0, coreStorageMigrations.findIndex((m) => m.id === "core-task-retirement-v1")); // pre-retirement schema: task/topic/background and every later reshape land after this step

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "topic-retire-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

function scopeTables(database: Database): string[] {
  return database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
    .map((r) => r.name)
    .filter((name) => database.all<{ name: string }>(`PRAGMA table_info(${name})`).some((c) => c.name === "scope_id"))
    // background_tasks is dropped by its own retirement migration
    // (core-background-retirement-v1); its removal is covered there.
    .filter((name) => name !== "background_tasks")
    // current_sessions loses its scope column to the member-session reshape
    // (core-member-session-v1); the topic-row check for it is asserted directly.
    .filter((name) => name !== "current_sessions")
    // runtime_checkpoints / runtime_stale_fields lose their scope column to the
    // member-runtime reshape (core-member-runtime-state-v1); their topic rows are
    // deleted by the retirement migration and asserted directly below.
    .filter((name) => name !== "runtime_checkpoints" && name !== "runtime_stale_fields");
}

/** Dynamic ownership scan: every table carrying scope_id + the special keys. */
function topicRowCounts(database: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of scopeTables(database)) {
    counts[table] = database.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE scope_id LIKE 'topic:%'`)!.n;
  }
  counts["topics"] = database.get<{ n: number }>("SELECT COUNT(*) n FROM topics")!.n;
  counts["topic_participants"] = database.get<{ n: number }>("SELECT COUNT(*) n FROM topic_participants")!.n;
  counts["scopes(kind=topic)"] = database.get<{ n: number }>("SELECT COUNT(*) n FROM scopes WHERE kind='topic'")!.n;
  counts["token_usage_daily(room_id)"] = database.get<{ n: number }>("SELECT COUNT(*) n FROM token_usage_daily WHERE room_id LIKE 'topic:%'")!.n;
  return counts;
}

/** Value-level main-chat snapshot (room + DM): rows, sequences, cursors, sessions, events, usage. */
function mainChatValues(database: Database) {
  return {
    messages: database.all("SELECT * FROM messages WHERE scope_id NOT LIKE 'topic:%' ORDER BY scope_id,seq"),
    seqs: database.all("SELECT * FROM scope_sequences WHERE scope_id NOT LIKE 'topic:%' ORDER BY scope_id"),
    cursors: database.all("SELECT * FROM read_cursors WHERE scope_id NOT LIKE 'topic:%' ORDER BY scope_id,kind,actor_key"),
    events: database.all("SELECT * FROM agent_events WHERE scope_id NOT LIKE 'topic:%' ORDER BY scope_id,owner_key,seq"),
    usage: database.all("SELECT * FROM token_usage_daily WHERE room_id NOT LIKE 'topic:%' ORDER BY room_id,member_id,date,model"),
  };
}

function zeroes(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(counts).map((k) => [k, 0]));
}

function seed(database: Database): void {
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('r1','room','r1',NULL),('dm:mem_m1','dm',NULL,'mem_m1'),('topic:t1','topic','r1',NULL)");
  database.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_m1','One','one','general','{}',1,1)");
  database.run("INSERT INTO rooms(id,name,created_at,docs_path,leader_member_id,leader_global_member_id,roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES('r1','R','0',NULL,NULL,NULL,'names',0,0,0)");
  database.run("INSERT INTO topics(id,scope_id,room_id,title,anchor_message_id,created_by,status,created_at,seed_mode) VALUES('t1','topic:t1','r1','T','a','user','active',0,'fresh')");
  database.run("INSERT INTO topic_participants(topic_id,position,member_ref) VALUES('t1',0,'mem_m1')");
  importMessage(database, "r1", { id: "room-msg", ts: 1, seq: 1, sender: "user", content: "room", mentions: [] } as any);
  importMessage(database, "dm:mem_m1", { id: "dm-msg", ts: 2, seq: 1, sender: "user", content: "dm", mentions: [] } as any);
  importMessage(database, "topic:t1", { id: "topic-msg", ts: 3, seq: 1, sender: "user", content: "topic", mentions: [] } as any);
  importMessageNextSequence(database, "r1", 5);
  importMessageNextSequence(database, "topic:t1", 9);
  database.run("INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES('r1','member','mem_m1','room-msg',10)");
  database.run("INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES('topic:t1','member','mem_m1','topic-msg',11)");
  database.run("INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES('topic:t1','user','user','topic-msg',12)");
  database.run("INSERT INTO current_sessions(member_id,scope_id,runtime,sdk_session_id,file_reference,reference_kind,created_at,updated_at) VALUES('mem_m1','r1','pi-sdk',NULL,NULL,'member-relative',1,1)");
  database.run("INSERT INTO current_sessions(member_id,scope_id,runtime,sdk_session_id,file_reference,reference_kind,created_at,updated_at) VALUES('mem_m1','topic:t1','pi-sdk',NULL,NULL,'member-relative',1,1)");
  database.run("INSERT INTO runtime_checkpoints(scope_id,member_id,contract_fingerprint,updated_at) VALUES('r1','mem_m1','room',5)");
  database.run("INSERT INTO runtime_checkpoints(scope_id,member_id,contract_fingerprint,updated_at) VALUES('topic:t1','mem_m1','topic',6)");
  database.run("INSERT INTO runtime_stale_fields(scope_id,member_id,field,ordinal) VALUES('topic:t1','mem_m1','a',0)");
  importAgentEvent(database, { id: "ev-room", scopeId: "r1", ownerKey: "mem_m1", memberId: "mem_m1", seq: 1, ts: 1, event: { type: "message_end", usage: { inputTokens: 7, outputTokens: 1, cost: 0.5 }, model: "p/m" } } as any);
  importAgentEvent(database, { id: "ev-topic", scopeId: "topic:t1", ownerKey: "mem_m1", memberId: "mem_m1", seq: 1, ts: 2, event: { type: "message_end", usage: { inputTokens: 11, outputTokens: 2, cost: 0.25 }, model: "p/m" } } as any);
  database.run("INSERT INTO dm_member_cursor_sequences(scope_id) VALUES('dm:mem_m1')");
  database.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('topic-work','topic:t1','k1','{}',1)");
  database.run("INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES('topic:t1','topic-msg','{}',1)");
  database.run("INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,target_member_id,delivery_kind,accepted_at) VALUES('topic:t1','topic-msg','mem_m1','mem_m1','ordinary',1)");
  database.run("INSERT INTO reply_obligations(scope_id,message_id,actor_key,member_id,reason,opened_at) VALUES('topic:t1','topic-msg','mem_m1','mem_m1','user',1)");
  database.run("INSERT INTO reply_obligation_dispositions(scope_id,message_id,actor_key,disposition,diagnosis,recorded_at) VALUES('topic:t1','topic-msg','mem_m1','cancelled','fixture',1)");
  database.run("INSERT INTO reply_settlements(scope_id,reply_message_id,actor_key,selection_json,settled_count,settled_at) VALUES('topic:t1','topic-msg','mem_m1','{}',1,1)");
  database.run("INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at) VALUES('topic:t1','topic-msg','mem_m1','ordinary','{}','fixture','pending',1)");
  database.run("INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES('members/mem_m1/memory/scopes/topic-t1/mainline.md','mainline','mem_m1','topic:t1',1,'h',0)");
  database.run("INSERT INTO memory_document_history(document_path,ordinal,revision,scope_id,ts,actor_type,operation,reason,content_hash,content_length,snapshot_path,snapshot_hash,snapshot_bytes) VALUES('members/mem_m1/memory/scopes/topic-t1/mainline.md',1,1,'topic:t1',1,'user','write','fixture','h',0,'snap.md','sh',0)");
}

describe("core-topic-retirement-v1", () => {
  it("deletes every topic-owned row in one transaction, keeps main chat value-identical and FK-clean", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    applyStorageMigrations(db, withoutRetirement());
    seed(db);
    const beforeChat = mainChatValues(db);
    const beforeTopic = topicRowCounts(db);
    expect(Object.values(beforeTopic).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

    applyStorageMigrations(db, coreStorageMigrations);

    expect(topicRowCounts(db)).toEqual(zeroes(beforeTopic));
    expect(mainChatValues(db)).toEqual(beforeChat);
    // The member-session reshape (① A1/A3) carries no legacy per-scope row over.
    expect(db.all("SELECT * FROM current_sessions")).toEqual([]);
    // Member-level runtime state (① B8 / C3): topic rows are gone and the
    // member's remaining checkpoint collapses to one member-keyed row.
    expect(db.all("SELECT * FROM runtime_checkpoints")).toEqual([
      { member_id: "mem_m1", contract_fingerprint: "room", contract_version: null, drift_notified: null, stale_since: null, updated_at: 5 },
    ]);
    expect(db.all("SELECT * FROM runtime_stale_fields")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);

    // Idempotent: re-application records nothing and deletes nothing further.
    applyStorageMigrations(db, coreStorageMigrations);
    expect(topicRowCounts(db)).toEqual(zeroes(beforeTopic));
    expect(mainChatValues(db)).toEqual(beforeChat);
  });

  it("rolls back with no half-delete when a delete fails mid-migration", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    applyStorageMigrations(db, withoutRetirement());
    seed(db);
    const beforeChat = mainChatValues(db);
    const beforeTopic = topicRowCounts(db);

    db.exec("CREATE TRIGGER block_topic_messages BEFORE DELETE ON messages WHEN OLD.scope_id LIKE 'topic:%' BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => applyStorageMigrations(db, coreStorageMigrations)).toThrow(/injected/);
    // Whole transaction rolled back — deletes ordered before `messages` are restored too.
    expect(topicRowCounts(db)).toEqual(beforeTopic);
    expect(mainChatValues(db)).toEqual(beforeChat);
    expect(db.get("SELECT COUNT(*) n FROM runtime_checkpoints")?.n).toBe(2);

    db.exec("DROP TRIGGER block_topic_messages");
    applyStorageMigrations(db, coreStorageMigrations);
    expect(topicRowCounts(db)).toEqual(zeroes(beforeTopic));
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});

describe("upgrade path end to end (prepareStorageUpgrade)", () => {
  it("migrates a pre-retirement DB, deletes topic data, cleans topic session files, and re-runs as a no-op", async () => {
    const { prepareStorageUpgrade } = await import("../../src/app/upgrade/run.js");
    // "Previous version": full schema minus the topic retirement migration, with topic rows seeded.
    const prev = openDatabase(join(root, "previous.sqlite"));
    applyStorageMigrations(prev, withoutRetirement());
    seed(prev);
    const beforeChat = mainChatValues(prev);
    const beforeTopic = topicRowCounts(prev);
    expect(Object.values(beforeTopic).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    prev.close();
    copyFileSync(join(root, "previous.sqlite"), join(root, "bossmode.db"));

    // Topic session files on disk, next to room/DM files that must survive.
    const sessions = join(root, "members", "mem_m1", "sessions", "2026-09-09");
    mkdirSync(join(sessions, "topics", "t1"), { recursive: true });
    writeFileSync(join(sessions, "topics", "t1", "fork.jsonl"), "fork");
    mkdirSync(join(sessions, "rooms", "r1"), { recursive: true });
    writeFileSync(join(sessions, "rooms", "r1", "room.jsonl"), "room");
    mkdirSync(join(sessions, "dm"), { recursive: true });
    writeFileSync(join(sessions, "dm", "dm.jsonl"), "dm");

    const options = {
      root,
      formatVersion: 999, // fixture has no authority marker → forces the upgrade path
      migrations: coreStorageMigrations,
      collectLegacySources: async () => [],
      importData: async () => {},
      validate: async () => {},
    };
    const first = await prepareStorageUpgrade(options);
    expect(first.migrated).toBe(true);
    expect(topicRowCounts(first.db)).toEqual(zeroes(beforeTopic));
    expect(mainChatValues(first.db)).toEqual(beforeChat);
    // Member-centric sessions (① A1/A3): the legacy per-scope rows are gone and
    // the files stay in place until the startup archive step moves them.
    expect(first.db.all("SELECT * FROM current_sessions")).toEqual([]);
    expect(first.db.all("PRAGMA foreign_key_check")).toEqual([]);

    // Session cleanup is a startup step, not part of the DB cutover — the upgrade alone leaves files.
    expect(existsSync(join(sessions, "topics"))).toBe(true);
    cleanupRetiredTopicSessionFiles(root, first.db);
    expect(existsSync(join(sessions, "topics"))).toBe(false);
    expect(existsSync(join(sessions, "rooms", "r1", "room.jsonl"))).toBe(true);
    expect(existsSync(join(sessions, "dm", "dm.jsonl"))).toBe(true);
    first.db.close();

    // Restart: authority marker now matches → no-op, nothing further deleted, chat untouched.
    const second = await prepareStorageUpgrade(options);
    expect(second.migrated).toBe(false);
    expect(topicRowCounts(second.db)).toEqual(zeroes(beforeTopic));
    expect(mainChatValues(second.db)).toEqual(beforeChat);
    expect(second.db.all("PRAGMA foreign_key_check")).toEqual([]);
    second.db.close();
  });
});

describe("topic session file cleanup", () => {
  it("removes topic session directories, never room/DM files, and records the completion flag", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    applyStorageMigrations(db, coreStorageMigrations);
    const sessions = join(root, "members", "mem_a", "sessions");
    mkdirSync(join(sessions, "2026-09-09", "rooms", "r1"), { recursive: true });
    writeFileSync(join(sessions, "2026-09-09", "rooms", "r1", "room.jsonl"), "room");
    mkdirSync(join(sessions, "2026-09-09", "dm"), { recursive: true });
    writeFileSync(join(sessions, "2026-09-09", "dm", "dm.jsonl"), "dm");
    writeFileSync(join(sessions, "current.json"), "{}");
    mkdirSync(join(sessions, "2026-09-09", "topics", "t1"), { recursive: true });
    writeFileSync(join(sessions, "2026-09-09", "topics", "t1", "fork.jsonl"), "fork");
    mkdirSync(join(sessions, "2026-09-10", "topic-legacy"), { recursive: true });
    writeFileSync(join(sessions, "2026-09-10", "topic-legacy", "old.jsonl"), "old");

    cleanupRetiredTopicSessionFiles(root, db);

    expect(existsSync(join(sessions, "2026-09-09", "topics"))).toBe(false);
    expect(existsSync(join(sessions, "2026-09-10", "topic-legacy"))).toBe(false);
    expect(existsSync(join(sessions, "2026-09-09", "rooms", "r1", "room.jsonl"))).toBe(true);
    expect(existsSync(join(sessions, "2026-09-09", "dm", "dm.jsonl"))).toBe(true);
    expect(existsSync(join(sessions, "current.json"))).toBe(true);
    const flag = db.get<{ value: string }>("SELECT value FROM storage_meta WHERE key='core-topic-session-cleanup-v1'");
    expect(JSON.parse(flag!.value)).toMatchObject({ removedDirectories: 2 });

    // Flag recorded: later startups never rescan (new files left in place by design).
    mkdirSync(join(sessions, "2026-09-11", "topics", "t2"), { recursive: true });
    cleanupRetiredTopicSessionFiles(root, db);
    expect(existsSync(join(sessions, "2026-09-11", "topics"))).toBe(true);
  });

  it("keeps the flag unset when the scan fails so a later startup retries without blocking", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    applyStorageMigrations(db, coreStorageMigrations);
    mkdirSync(join(root, "members", "mem_b"), { recursive: true });
    writeFileSync(join(root, "members", "mem_b", "sessions"), "not a directory");
    cleanupRetiredTopicSessionFiles(root, db);
    expect(db.get("SELECT 1 FROM storage_meta WHERE key='core-topic-session-cleanup-v1'")).toBeUndefined();

    rmSync(join(root, "members", "mem_b", "sessions"));
    mkdirSync(join(root, "members", "mem_b", "sessions", "2026-09-09", "topics", "t9"), { recursive: true });
    cleanupRetiredTopicSessionFiles(root, db);
    expect(db.get("SELECT 1 FROM storage_meta WHERE key='core-topic-session-cleanup-v1'")).toBeDefined();
    expect(existsSync(join(root, "members", "mem_b", "sessions", "2026-09-09", "topics"))).toBe(false);
  });
});
