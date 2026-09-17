import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { loadShortIdMapping, migrateShortIds, replayShortIdJournalFromDisk, writeShortIdJournal } from "../../src/app/upgrade/ids.js";
import { mmScopeIdOf } from "../../src/chat/conversations.js";

const M1 = "mem_11111111-1111-4111-8111-111111111111";
const M2 = "mem_22222222-2222-4222-8222-222222222222";
const R1 = "aaaaaaaa-1111-4111-8111-111111111111";
const DM = `dm:${M1}`;
const MM = mmScopeIdOf(M1, M2);

let root: string;
let db: Database | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "short-id-db-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

function seed(database: Database): void {
  database.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)",
    M1, "Aaa", "aaa", "general", "{}", 1, 1,
    M2, "Bbb", "bbb", "general", "{}", 1, 1,
  );
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES (?,?,?,?)", DM, "dm", null, M1);
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES (?,?,?,?)", MM, "mm", null, `${M1}|${M2}`);
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES (?,?,?,?)", R1, "room", R1, null);
  database.run(
    "INSERT INTO rooms(id,name,created_at,docs_path,roster_kind,has_local_records,has_rule_docs,has_overrides,leader_global_member_id) VALUES (?,?,?,?,?,?,?,?,?)",
    R1, "Room", 1, "room", "global", 0, 0, 0, M1,
  );
  const emptyExtra = '{"fields":{},"presentLists":[]}';
  database.run(
    "INSERT INTO messages(scope_id,id,seq,ts,sender,sender_member_id,origin,content,content_lower,extra_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    DM, "msg-1", 1, 1, M1, M1, "member", "hi", "hi", emptyExtra,
  );
  database.run(
    "INSERT INTO messages(scope_id,id,seq,ts,sender,sender_member_id,origin,content,content_lower,extra_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
    MM, "msg-2", 1, 1, M2, M2, "member", "private", "private", emptyExtra,
  );
  database.run("INSERT INTO message_mentions(scope_id,message_id,kind,value_kind,ordinal,value) VALUES (?,?,?,?,?,?)", DM, "msg-1", "mention", "id", 0, M1);
  database.run("INSERT INTO message_mentions(scope_id,message_id,kind,value_kind,ordinal,value) VALUES (?,?,?,?,?,?)", DM, "msg-1", "mention", "label", 0, "Bbb");
  database.run("INSERT INTO scope_sequences(scope_id,next_seq) VALUES (?,?),(?,?),(?,?)", DM, 2, MM, 2, R1, 2);
  database.run("INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES (?,?,?,?,?)", DM, "member", M1, null, 1);
  database.run(
    "INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES ('message',?,?,?,?)",
    DM, `message:${DM}:msg-1`,
    JSON.stringify({ messageId: "msg-1", message: { id: "msg-1", sender: M1, senderMemberId: M1, content: "hi", mentions: ["Bbb"], mentionMemberIds: [M1], seq: 1, ts: 1 } }),
    1,
  );
  database.run(
    "INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES ('message',?,?,?,?)",
    R1, `message:${R1}:msg-9`, JSON.stringify({ messageId: "msg-9", assigneeMemberId: M1, subscriberMemberIds: [M1, M2] }), 1,
  );
  database.run(
    "INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES (?,?,?,?)",
    DM, "msg-1",
    JSON.stringify({ context: {}, message: { content: "hi", id: "msg-1", mentionMemberIds: [M1], mentions: ["Bbb"], sender: M1, senderMemberId: M1 }, needResponse: null, origin: "member", senderActorKey: M1 }),
    1,
  );
  database.run("INSERT INTO reply_obligations(scope_id,message_id,actor_key,member_id,reason,opened_at,settled_at,settled_by_message_id) VALUES (?,?,?,?,?,?,?,?)", DM, "msg-1", M1, M1, "user", 1, null, null);
  database.run("INSERT INTO reply_obligation_dispositions(scope_id,message_id,actor_key,disposition,diagnosis,recorded_at) VALUES (?,?,?,?,?,?)", DM, "msg-1", M1, "silent", "test", 1);
  database.run("INSERT INTO reply_settlements(scope_id,reply_message_id,actor_key,selection_json,settled_count,settled_at) VALUES (?,?,?,?,?,?)", DM, "msg-1", M1, "{}", 1, 1);
  database.run("INSERT INTO agent_events(id,scope_id,owner_key,member_id,seq,ts,type,payload_json) VALUES (?,?,?,?,?,?,?,?)", "ev-1", DM, `legacy-unresolved:${M1}`, null, 1, 1, "test", "{}");
  database.run("INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,target_member_id,delivery_kind,accepted_at) VALUES (?,?,?,?,?,?)", DM, "msg-1", M1, M1, "ordinary", 1);
  database.run(
    "INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,placement) VALUES (?,?,?,?,?,?,?,?,?)",
    DM, "msg-1", M1, "ordinary", JSON.stringify({ prompt: "[REPLY EXPECTED] hi", senderMemberId: M1 }), "message", "pending", 1, "tail",
  );
  database.run("INSERT INTO storage_meta(key,value) VALUES (?,?)", "legacy-event-occurrence-v1:abc:1",
    JSON.stringify({ path: `rooms/${R1}/agent-events/${M1}.jsonl`, ordinal: 1, eventId: "legacy:deadbeef",
      scopeId: R1, ownerKey: M1, memberId: null, sourceScopeId: R1, sourceOwnerKey: M1 }));
  database.run("INSERT INTO storage_upgrade_files(path,backup_path,hash,retire,retired_at) VALUES (?,?,?,?,?)", `members/${M1}/persona.md`, `members/${M1}/persona.md`, "h", 0, null);
  database.run("INSERT INTO storage_upgrade_files(path,backup_path,hash,retire,retired_at) VALUES (?,?,?,?,?)",
    `backups/fired-${M1}/memory/scopes/room-${R1}/x.jsonl`, `backups/core-upgrade/files/x.jsonl`, "h", 0, null);
  database.run("INSERT INTO member_archive_intents(member_id,source_path,archive_path,source_device,source_inode,state,created_at,completed_at) VALUES (?,?,?,?,?,'pending',?,NULL)",
    M1, `members/${M1}`, `backups/fired-${M1}-abc`, "1", "2", 1);
  database.run("INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES(?,?,?,?,?,?,?)",
    `rooms/${R1}/memory/members/${M1}/mainline.md`, "mainline", M1, R1, 1, "h", 1);
  database.run("INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES(?,?,?,?,?,?,?)",
    `members/${M1}/memory/scopes/room-${R1}/mainline.md`, "mainline", M1, R1, 1, "h", 1);
  database.run("INSERT INTO memory_document_history(document_path,ordinal,revision,scope_id,ts,actor_type,actor_member_id,actor_name,operation,reason,content_hash,content_length,snapshot_path,snapshot_hash,snapshot_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    `rooms/${R1}/memory/members/${M1}/mainline.md`, 1, 1, R1, 1, "member", M1, "Aaa", "update", "test", "h", 1,
    `rooms/${R1}/memory/members/${M1}/history/mainline/x.md`, "h", 1);
}

describe("migrateShortIds (DB rewrite + FS + flag)", () => {
  it("rewrites every surface in one transaction, keeps triggers verbatim, renames files, and is idempotent", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, coreStorageMigrations);
    seed(database);
    mkdirSync(join(root, "members", M1), { recursive: true });
    writeFileSync(join(root, "members", M1, "persona.md"), "p");
    mkdirSync(join(root, "rooms", R1, "agent-events"), { recursive: true });
    writeFileSync(join(root, "rooms", R1, "agent-events", `${M1}.jsonl`), "{}");
    mkdirSync(join(root, "members", M1, "memory", "scopes", `room-${R1}`), { recursive: true });
    writeFileSync(join(root, "members", M1, "memory", "scopes", `room-${R1}`, "mainline.md"), "x");
    mkdirSync(join(root, "members", M1, "archive"), { recursive: true });
    writeFileSync(join(root, "members", M1, "archive", `mainline-room-${R1}.md`), "y");
    const triggersBefore = database.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name");

    const report = migrateShortIds(root, database);
    expect(report.status).toBe("migrated");
    expect(report.members).toBe(2);
    expect(report.rooms).toBe(1);
    expect(report.filesRenamed).toBeGreaterThanOrEqual(2);

    const mapping = loadShortIdMapping(database)!;
    const n1 = mapping.members.get(M1)!;
    const n2 = mapping.members.get(M2)!;
    const nr = mapping.rooms.get(R1)!;
    expect(n1).toMatch(/^mem_[0-9a-z]{10}$/);
    expect(nr).toMatch(/^rm_[0-9a-z]{10}$/);

    // Roots + scopes.
    expect(database.get("SELECT COUNT(*) AS n FROM members WHERE id=?", n1)!.n).toBe(1);
    expect(database.get("SELECT COUNT(*) AS n FROM members WHERE id=?", n2)!.n).toBe(1);
    const [nn1, nn2] = [n1, n2].sort();
    expect(database.all("SELECT id,kind,room_id,member_id FROM scopes ORDER BY kind")).toEqual([
      { id: `dm:${n1}`, kind: "dm", room_id: null, member_id: n1 },
      { id: mmScopeIdOf(n1, n2), kind: "mm", room_id: null, member_id: `${nn1}|${nn2}` },
      { id: nr, kind: "room", room_id: nr, member_id: null },
    ]);
    expect(database.get("SELECT COUNT(*) AS n FROM rooms WHERE id=?", nr)!.n).toBe(1);

    // Messages / mentions / cursors / delivery tables.
    expect(database.get("SELECT COUNT(*) AS n FROM messages WHERE scope_id=?", `dm:${n1}`)!.n).toBe(1);
    expect(database.get("SELECT COUNT(*) AS n FROM messages WHERE scope_id=?", mmScopeIdOf(n1, n2))!.n).toBe(1);
    expect(database.get<{ sender_member_id: string }>("SELECT sender_member_id FROM messages WHERE id='msg-1'")!.sender_member_id).toBe(n1);
    expect(database.get<{ value: string }>("SELECT value FROM message_mentions WHERE message_id='msg-1' AND value_kind='id'")!.value).toBe(n1);
    expect(database.get<{ value: string }>("SELECT value FROM message_mentions WHERE message_id='msg-1' AND value_kind='label'")!.value).toBe("Bbb");
    expect(database.get<{ actor_key: string }>("SELECT actor_key FROM read_cursors WHERE scope_id=?", `dm:${n1}`)!.actor_key).toBe(n1);
    expect(database.get<{ target_actor_key: string }>("SELECT target_actor_key FROM captured_deliveries")!.target_actor_key).toBe(n1);
    expect(database.get<{ target_actor_key: string }>("SELECT target_actor_key FROM queued_inputs")!.target_actor_key).toBe(n1);
    expect(database.get<{ actor_key: string; member_id: string }>("SELECT actor_key,member_id FROM reply_obligations")!.actor_key).toBe(n1);
    expect(database.get<{ member_id: string }>("SELECT member_id FROM reply_obligations")!.member_id).toBe(n1);
    expect(database.get<{ actor_key: string }>("SELECT actor_key FROM reply_obligation_dispositions")!.actor_key).toBe(n1);
    expect(database.get<{ actor_key: string }>("SELECT actor_key FROM reply_settlements")!.actor_key).toBe(n1);
    expect(database.get<{ scope_id: string }>("SELECT scope_id FROM reply_settlements")!.scope_id).toBe(`dm:${n1}`);
    expect(database.get<{ owner_key: string }>("SELECT owner_key FROM agent_events")!.owner_key).toBe(`legacy-unresolved:${n1}`);

    // Structured JSON replacement (known keys only).
    const outbox = database.get<{ dedupe_key: string; payload_json: string }>("SELECT dedupe_key,payload_json FROM outbox")!;
    expect(outbox.dedupe_key).toBe(`message:dm:${n1}:msg-1`);
    const payload = JSON.parse(outbox.payload_json) as { message: { senderMemberId: string; mentionMemberIds: string[]; mentions: string[] } };
    expect(payload.message.senderMemberId).toBe(n1);
    expect(payload.message.mentionMemberIds).toEqual([n1]);
    expect(payload.message.mentions).toEqual(["Bbb"]); // names untouched
    const snapshot = JSON.parse(database.get<{ snapshot_json: string }>("SELECT snapshot_json FROM delivery_captures")!.snapshot_json) as { senderActorKey: string; message: { mentionMemberIds: string[] } };
    expect(snapshot.senderActorKey).toBe(n1);
    expect(snapshot.message.mentionMemberIds).toEqual([n1]);

    // Ledger paths + source-key rewrite; colon-delimited room dedupe keys.
    const ledger = JSON.parse(database.get<{ value: string }>("SELECT value FROM storage_meta WHERE key LIKE 'legacy-event-occurrence-v1:%'")!.value) as {
      path: string; scopeId: string; sourceScopeId: string; sourceOwnerKey: string;
    };
    expect(ledger.path).toBe(`rooms/${nr}/agent-events/${n1}.jsonl`);
    expect(ledger.scopeId).toBe(nr);
    expect(ledger.sourceScopeId).toBe(nr);
    expect(ledger.sourceOwnerKey).toBe(n1);
    const roomOutbox = database.get<{ dedupe_key: string; payload_json: string; scope_id: string }>("SELECT dedupe_key,payload_json,scope_id FROM outbox WHERE scope_id=?", nr)!;
    expect(roomOutbox.dedupe_key).toBe(`message:${nr}:msg-9`);
    expect((JSON.parse(roomOutbox.payload_json) as { assigneeMemberId: string; subscriberMemberIds: string[] }).assigneeMemberId).toBe(n1);
    expect((JSON.parse(roomOutbox.payload_json) as { subscriberMemberIds: string[] }).subscriberMemberIds).toEqual([n1, n2]);
    expect(database.get<{ path: string }>("SELECT path FROM storage_upgrade_files WHERE path LIKE 'members/%'")!.path).toBe(`members/${n1}/persona.md`);
    // Exclusion zones keep the old ids: their disk names never change.
    expect(database.get<{ path: string }>("SELECT path FROM storage_upgrade_files WHERE path LIKE 'backups/%'")!.path).toBe(`backups/fired-${M1}/memory/scopes/room-${R1}/x.jsonl`);
    const intent = database.get<{ member_id: string; source_path: string; archive_path: string }>("SELECT member_id,source_path,archive_path FROM member_archive_intents")!;
    expect(intent.member_id).toBe(n1);
    expect(intent.source_path).toBe(`members/${n1}`);
    expect(intent.archive_path).toBe(`backups/fired-${M1}-abc`); // archive path keeps the old form

    // Legacy room-tree member segments keep the old form in DB (mirrors the filesystem);
    // other room forms still follow.
    expect(database.get<{ path: string }>("SELECT path FROM memory_documents WHERE path LIKE 'rooms/%'")!.path).toBe(`rooms/${nr}/memory/members/${M1}/mainline.md`);
    expect(database.get<{ path: string }>("SELECT path FROM memory_documents WHERE path LIKE 'members/%memory/scopes%'")!.path).toBe(`members/${n1}/memory/scopes/room-${nr}/mainline.md`);
    const historyRow = database.get<{ document_path: string; snapshot_path: string }>("SELECT document_path,snapshot_path FROM memory_document_history")!;
    expect(historyRow.document_path).toBe(`rooms/${nr}/memory/members/${M1}/mainline.md`);
    expect(historyRow.snapshot_path).toBe(`rooms/${nr}/memory/members/${M1}/history/mainline/x.md`);

    // Filesystem: room-<id> dash forms (dirs + embedded names) are renamed.
    expect(existsSync(join(root, "members", n1, "memory", "scopes", `room-${nr}`, "mainline.md"))).toBe(true);
    expect(existsSync(join(root, "members", n1, "archive", `mainline-room-${nr}.md`))).toBe(true);

    // Trigger DDL round-trip is byte-identical; the guard still blocks rewrites.
    expect(database.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")).toEqual(triggersBefore);
    expect(() => database.run("UPDATE queued_inputs SET payload_json='{}'")).toThrow();

    // Filesystem renames + journal cleared + mirror + done flag.
    expect(existsSync(join(root, "members", n1, "persona.md"))).toBe(true);
    expect(existsSync(join(root, "rooms", nr, "agent-events", `${n1}.jsonl`))).toBe(true);
    expect(existsSync(join(root, "migrations", "core-short-ids-v1.journal.json"))).toBe(false);
    expect(existsSync(join(root, "archive", "id-migration", "core-short-ids-v1.json"))).toBe(true);
    expect(database.get("SELECT 1 FROM storage_meta WHERE key='core-short-ids-v1'")).toBeDefined();

    // Second run is a no-op.
    const second = migrateShortIds(root, database);
    expect(second.status).toBe("already-done");
  });

  it("clears a stale pre-commit journal and completes from scratch (W1 self-healing)", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, coreStorageMigrations);
    seed(database);
    mkdirSync(join(root, "members", M1), { recursive: true });
    writeFileSync(join(root, "members", M1, "persona.md"), "p");
    // A run that journaled its rename plan and then died before the rewrite committed.
    writeShortIdJournal(root, [{ from: `members/${M1}`, to: "members/mem_neverapplied0" }]);

    expect(replayShortIdJournalFromDisk(root)).toEqual({ status: "stale" });
    expect(existsSync(join(root, "migrations", "core-short-ids-v1.journal.json"))).toBe(false);
    expect(existsSync(join(root, "members", M1, "persona.md"))).toBe(true); // nothing was renamed

    const report = migrateShortIds(root, database);
    expect(report.status).toBe("migrated");
    const n1 = loadShortIdMapping(database)!.members.get(M1)!;
    expect(existsSync(join(root, "members", n1, "persona.md"))).toBe(true);
  });
});
