import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyStorageMigrations, openDatabase } from "../src/data/database.js";
import { coreStorageMigrations } from "../src/data/schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("core-agent-queue-v2 migration", () => {
  it("preserves history, queue terminal states, receipts and historical event identity", () => {
    const root = mkdtempSync(join(tmpdir(), "bossmode-r2-v2-")); roots.push(root);
    const db = openDatabase(join(root, "core.db"));
    const old = coreStorageMigrations.slice(0, coreStorageMigrations.findIndex(m => m.id === "core-agent-queue-v2"));
    applyStorageMigrations(db, old);
    const checksums = db.all<{id:string;checksum:string}>("SELECT id,checksum FROM storage_schema_versions ORDER BY rowid");
    expect(checksums).toHaveLength(22);
    db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", "mem_one", "One", "one", "x", "{}", 1, 1);
    db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('r1','room','r1',NULL)");
    const states = [
      { status: "pending", dispatched: null, ended: null, token: null, outcome: null, result: null, diagnosis: null },
      { status: "dispatched", dispatched: 10, ended: null, token: "token-1", outcome: null, result: null, diagnosis: null },
      { status: "settled", dispatched: 11, ended: 20, token: "token-2", outcome: "completed", result: "{}", diagnosis: null },
      { status: "interrupted", dispatched: null, ended: 20, token: null, outcome: null, result: null, diagnosis: "stopped" },
      { status: "uncertain", dispatched: 12, ended: 20, token: "token-4", outcome: null, result: null, diagnosis: "lost receipt" },
    ];
    for (const [index, state] of states.entries()) {
      const message = `msg-${index}`;
      db.run("INSERT INTO delivery_captures VALUES(?,?,?,?)", "r1", message, JSON.stringify({ messageId: message }), index + 1);
      db.run("INSERT INTO captured_deliveries VALUES(?,?,?,?,?,?)", "r1", message, "mem_one", "mem_one", "ordinary", index + 1);
      db.run(`INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,dispatched_at,ended_at,dispatch_token,outcome,result_json,diagnosis,placement)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, "r1", message, "mem_one", "ordinary", JSON.stringify({ prompt: message, replySources: [message] }), "chat-message", state.status, index + 1,
        state.dispatched, state.ended, state.token, state.outcome, state.result, state.diagnosis, "tail");
    }
    db.run("INSERT INTO reply_obligations VALUES(?,?,?,?,?,?,?,?)", "r1", "msg-0", "mem_one", "mem_one", "explicit", 1, null, null);
    db.run("INSERT INTO delivery_captures VALUES(?,?,?,?)", "r1", "msg-history", JSON.stringify({ messageId: "msg-history" }), 6);
    db.run("INSERT INTO captured_deliveries VALUES(?,?,?,?,?,?)", "r1", "msg-history", "old-actor", null, "ordinary", 6);
    db.run(`INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,ended_at,diagnosis,placement)
      VALUES(?,?,?,?,?,?,'interrupted',?,?,?,'tail')`, "r1", "msg-history", "old-actor", "ordinary", JSON.stringify({ prompt: "old" }), "chat-message", 6, 20, "historical");
    db.run("INSERT INTO execution_attempts VALUES(?,?,?,?,?,?,?,?,?,?)", "attempt-1", "mem_one", "r1", "input", null, "prepared", 1, null, null, null);
    db.run("INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?)", "event-member", "r1", "mem_one", "mem_one", 4, 100, "message_end", JSON.stringify({ type: "message_end", usage: { inputTokens: 3, outputTokens: 2, cost: 0.4 } }));
    // Lower wall-clock time must not reorder the immutable historical stream.
    db.run("INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?)", "event-member-next", "r1", "mem_one", "mem_one", 5, 50, "tool_start", JSON.stringify({ type: "tool_start" }));
    db.run("INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?)", "event-history", "r1", "old-display", null, 7, 90, "tool_start", JSON.stringify({ type: "tool_start" }));
    db.run("INSERT INTO event_usage_receipts VALUES(?,?)", "event-member", 5);
    db.run("INSERT INTO event_source_receipts VALUES(?,?)", "event-member", "hash");
    db.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('agent-event','r1','event-member','{}',100)");

    applyStorageMigrations(db, coreStorageMigrations);
    expect(db.all("SELECT id,checksum FROM storage_schema_versions ORDER BY rowid LIMIT 22")).toEqual(checksums);
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM storage_schema_versions")!.n).toBe(coreStorageMigrations.length);
    expect(db.all("SELECT id,member_id,historical_target_actor_key,source_ref,status,outcome,diagnosis FROM queued_inputs ORDER BY id")).toEqual([
      { id: 1, member_id: "mem_one", historical_target_actor_key: "mem_one", source_ref: "room:r1", status: "pending", outcome: null, diagnosis: null },
      { id: 2, member_id: "mem_one", historical_target_actor_key: "mem_one", source_ref: "room:r1", status: "dispatched", outcome: null, diagnosis: null },
      { id: 3, member_id: "mem_one", historical_target_actor_key: "mem_one", source_ref: "room:r1", status: "settled", outcome: "completed", diagnosis: null },
      { id: 4, member_id: "mem_one", historical_target_actor_key: "mem_one", source_ref: "room:r1", status: "interrupted", outcome: null, diagnosis: "stopped" },
      { id: 5, member_id: "mem_one", historical_target_actor_key: "mem_one", source_ref: "room:r1", status: "uncertain", outcome: null, diagnosis: "lost receipt" },
      { id: 6, member_id: null, historical_target_actor_key: "old-actor", source_ref: "room:r1", status: "interrupted", outcome: null, diagnosis: "historical" },
    ]);
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM chat_admissions")!.n).toBe(6);
    expect(db.get("SELECT id,member_id,source_ref,status FROM execution_attempts")).toEqual({ id: "attempt-1", member_id: "mem_one", source_ref: "room:r1", status: "prepared" });
    expect(db.get("SELECT id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq FROM agent_events WHERE id='event-member'")).toEqual({
      id: "event-member", member_id: "mem_one", source_ref: "room:r1", member_seq: 1, historical_source_key: "r1", historical_owner_key: "mem_one", historical_seq: 4,
    });
    expect(db.get("SELECT id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq FROM agent_events WHERE id='event-member-next'")).toEqual({
      id: "event-member-next", member_id: "mem_one", source_ref: "room:r1", member_seq: 2, historical_source_key: "r1", historical_owner_key: "mem_one", historical_seq: 5,
    });
    expect(db.get("SELECT id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq FROM agent_events WHERE id='event-history'")).toEqual({
      id: "event-history", member_id: null, source_ref: null, member_seq: null, historical_source_key: "r1", historical_owner_key: "old-display", historical_seq: 7,
    });
    expect(() => db.run("UPDATE agent_events SET historical_seq=9 WHERE id='event-member'"))
      .toThrow("Historical event identity is immutable");
    expect(db.get("SELECT * FROM event_usage_receipts")).toEqual({ event_id: "event-member", total_tokens: 5 });
    expect(db.get("SELECT * FROM event_source_receipts")).toEqual({
      event_id: "event-member", input_fingerprint: "hash", source_key: "", source_seq: 0,
    });
    db.run("INSERT INTO event_source_receipts(event_id,input_fingerprint,source_key,source_seq) VALUES(?,?,?,?)",
      "event-member", "hash", "rooms/r1/events.jsonl", 4);
    expect(() => db.run("INSERT INTO event_source_receipts(event_id,input_fingerprint,source_key,source_seq) VALUES(?,?,?,?)",
      "event-member-next", "other", "rooms/r1/events.jsonl", 4)).toThrow("UNIQUE");
    expect(db.get<{scope_id:string}>("SELECT scope_id FROM outbox WHERE kind='agent-event'")!.scope_id).toBe("room:r1");
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    applyStorageMigrations(db, coreStorageMigrations);
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs")!.n).toBe(6);
    db.close();
  });
});
