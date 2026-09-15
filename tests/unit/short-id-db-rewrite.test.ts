import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/storage/database.js";
import { coreStorageMigrations } from "../../src/storage/migrations.js";
import { loadShortIdMapping, migrateShortIds } from "../../src/storage/short-id-migration.js";
import { mmScopeIdOf } from "../../src/shared/conversation-ref.js";

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
    "INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES (?,?,?,?)",
    DM, "msg-1",
    JSON.stringify({ context: {}, message: { content: "hi", id: "msg-1", mentionMemberIds: [M1], mentions: ["Bbb"], sender: M1, senderMemberId: M1 }, needResponse: null, origin: "member", senderActorKey: M1 }),
    1,
  );
  database.run("INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,target_member_id,delivery_kind,accepted_at) VALUES (?,?,?,?,?,?)", DM, "msg-1", M1, M1, "ordinary", 1);
  database.run(
    "INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,placement) VALUES (?,?,?,?,?,?,?,?,?)",
    DM, "msg-1", M1, "ordinary", JSON.stringify({ prompt: "[REPLY EXPECTED] hi", senderMemberId: M1 }), "message", "pending", 1, "tail",
  );
  database.run("INSERT INTO storage_meta(key,value) VALUES (?,?)", "legacy-event-occurrence-v1:abc:1",
    JSON.stringify({ path: `rooms/${R1}/agent-events/${M1}.jsonl`, ordinal: 1, eventId: "legacy:deadbeef" }));
  database.run("INSERT INTO storage_upgrade_files(path,backup_path,hash,retire,retired_at) VALUES (?,?,?,?,?)", `members/${M1}/persona.md`, `members/${M1}/persona.md`, "h", 0, null);
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

    // Ledger paths.
    const ledger = JSON.parse(database.get<{ value: string }>("SELECT value FROM storage_meta WHERE key LIKE 'legacy-event-occurrence-v1:%'")!.value) as { path: string };
    expect(ledger.path).toBe(`rooms/${nr}/agent-events/${n1}.jsonl`);
    expect(database.get<{ path: string }>("SELECT path FROM storage_upgrade_files")!.path).toBe(`members/${n1}/persona.md`);

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
});
