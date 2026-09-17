import { getMigration } from "./helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const messagesMigration = getMigration("core-messages-v1");
const eventSourceMigration = getMigration("core-event-source-v1");
import { appendAgentEvent, readAgentEvents, readStats } from "../src/data/repositories/event-repository.js";
import { handleAgentEvent, persistAgentEvent, type AgentHistoryEvent } from "../src/agent/events/event-handler.js";
import type { AgentStreamEvent } from "../src/agent/runtime/types.js";

const transport = vi.hoisted(() => ({ agent: vi.fn(), refresh: vi.fn(), knowledge: vi.fn() }));
vi.mock("../src/app/server/ws.js", () => ({ broadcastToAgentSubscribers: transport.agent }));
vi.mock("../src/agent/orchestrator/agent-manager.js", () => ({ refreshContextUsage: transport.refresh }));
vi.mock("../src/agent/events/knowledge-activity.js", () => ({ maybeEmitKnowledgeActivity: transport.knowledge }));
vi.mock("../src/chat/conversations.js", () => ({ getRoom: vi.fn() }));
vi.mock("../src/kernel/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

let db: Database;
let root: string;
let buffer: AgentHistoryEvent[];
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const finalEvent = (): AgentStreamEvent => ({ type: "message_end", usage: { inputTokens: 9, outputTokens: 3 } });
function handle(event: AgentStreamEvent, id: string) {
  return handleAgentEvent("room", "name", root, event, buffer, "mem", "provider/model", id);
}
function stream() {
  handle({ type: "message_update", text: "complete " }, "delta-1");
  handle({ type: "message_update", text: "text", thinking: "complete " }, "delta-2");
  handle({ type: "message_update", thinking: "thinking" }, "delta-3");
  transport.agent.mockClear();
}
function count(table: string) { return db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n; }
function assertComplete() {
  expect(readAgentEvents("room", "mem")).toEqual([expect.objectContaining({
    type: "message_end", text: "complete text", thinking: "complete thinking", model: "provider/model",
    usage: { inputTokens: 9, outputTokens: 3 },
  })]);
  expect(readStats("room", "mem").tokens).toMatchObject({ input: 9, output: 3 });
  for (const table of ["agent_events", "event_usage_receipts", "event_source_receipts", "token_usage_daily", "outbox"]) expect(count(table)).toBe(1);
}
beforeEach(() => {
  root = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!, "event-retry-"));
  db = openDatabase(join(root, "test.sqlite"));
  applyStorageMigrations(db, [baseStorageMigration, messagesMigration, eventSourceMigration]);
  bindDatabase(db);
  db.run("INSERT INTO scopes VALUES('room','room','room',NULL)");
  buffer = [];
  vi.clearAllMocks();
});
afterEach(async () => {
  await flush();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("event-handler retry contract", () => {
  it("replays a timestamp-less final by explicit ID after the clock advances without changing the complete fact or usage/outbox", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    stream();
    handle(finalEvent(), "final");
    await flush();
    assertComplete();
    const fact = db.get("SELECT * FROM agent_events WHERE id='final'");
    const receipt = db.get("SELECT * FROM event_usage_receipts");
    const usage = db.get("SELECT * FROM token_usage_daily");
    const outbox = db.get("SELECT * FROM outbox");
    clock.mockReturnValue(2000);
    expect(() => handle(finalEvent(), "final")).not.toThrow();
    await flush();
    assertComplete();
    expect(db.get("SELECT * FROM agent_events WHERE id='final'")).toEqual(fact);
    expect(db.get("SELECT * FROM event_usage_receipts")).toEqual(receipt);
    expect(db.get("SELECT * FROM token_usage_daily")).toEqual(usage);
    expect(db.get("SELECT * FROM outbox")).toEqual(outbox);
    expect(transport.agent).toHaveBeenCalledTimes(1);
    expect(buffer).toHaveLength(1);
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it("retains complete streamed text/thinking after outbox insertion failure for retry of the same final ID", async () => {
    stream();
    db.exec("CREATE TRIGGER fail_event_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END");
    expect(() => handle(finalEvent(), "final")).toThrow("injected outbox failure");
    await flush();
    expect(buffer).toEqual([]);
    expect(transport.agent).not.toHaveBeenCalled();
    for (const table of ["agent_events", "member_statistics", "event_usage_receipts", "event_source_receipts", "token_usage_daily", "outbox"]) expect(count(table)).toBe(0);
    db.exec("DROP TRIGGER fail_event_outbox");
    handle(finalEvent(), "final");
    await flush();
    assertComplete();
  });

  it("retains complete streamed text/thinking when the enclosing transaction rolls back", async () => {
    stream();
    expect(() => db.transaction(() => {
      handle(finalEvent(), "final");
      throw new Error("enclosing rollback");
    })).toThrow("enclosing rollback");
    await flush();
    for (const table of ["agent_events", "member_statistics", "event_usage_receipts", "event_source_receipts", "token_usage_daily", "outbox"]) expect(count(table)).toBe(0);
    expect(transport.agent).not.toHaveBeenCalled();
    handle(finalEvent(), "final");
    await flush();
    assertComplete();
  });

  it("does not add an uncommitted final to the success buffer on enclosing rollback", async () => {
    stream();
    expect(() => db.transaction(() => {
      handle(finalEvent(), "final");
      throw new Error("enclosing rollback");
    })).toThrow("enclosing rollback");
    await flush();
    expect(buffer).toEqual([]);
    expect(transport.agent).not.toHaveBeenCalled();
    expect(transport.refresh).not.toHaveBeenCalled();
  });

  it("rejects genuinely conflicting final payloads under the same event ID", () => {
    const event: AgentStreamEvent = { ...finalEvent(), text: "first", ts: 1000 };
    handle(event, "final");
    expect(() => handle({ ...event, text: "changed" }, "final")).toThrow("Conflicting event identity");
    expect(count("agent_events")).toBe(1);
    expect(count("event_usage_receipts")).toBe(1);
    expect(count("outbox")).toBe(1);
  });

  it("returns the original complete fact after reopening, without using a newer stream/model", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    stream();
    handle(finalEvent(), "final");
    await flush();
    const original = buffer[0];
    db.close();
    db = openDatabase(join(root, "test.sqlite"));
    bindDatabase(db);
    handle({ type: "message_update", text: "new text", thinking: "new thinking" }, "new-delta");
    transport.agent.mockClear();
    vi.mocked(Date.now).mockReturnValue(2000);
    const replay = persistAgentEvent("room", { ownerKey: "mem", memberId: "mem", label: "renamed" }, finalEvent(), "final");
    expect(replay).toEqual(original);
    handleAgentEvent("room", "renamed", root, finalEvent(), buffer, "mem", "different/model", "final");
    expect(buffer).toEqual([original]);
    expect(transport.refresh).toHaveBeenCalledTimes(1);
    await flush();
    expect(transport.agent).not.toHaveBeenCalled();
    handle(finalEvent(), "new-final");
    expect(buffer[1]).toMatchObject({ text: "new text", thinking: "new thinking", ts: 2000 });
    expect(count("agent_events")).toBe(2);
  });

  it("waits for outer COMMIT before buffer/context effects, and consumes only the captured stream prefix", () => {
    stream();
    db.transaction(() => {
      handle(finalEvent(), "final");
      expect(buffer).toEqual([]);
      expect(transport.refresh).not.toHaveBeenCalled();
      expect(transport.agent).not.toHaveBeenCalled();
      handle({ type: "message_update", text: "next text", thinking: "next thinking" }, "next-delta");
      // Same ID inside the enclosing transaction is a replay, not a second callback.
      handle(finalEvent(), "final");
      expect(buffer).toEqual([]);
    });
    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toMatchObject({ text: "complete text", thinking: "complete thinking" });
    expect(transport.refresh).toHaveBeenCalledTimes(1);
    handle(finalEvent(), "next-final");
    expect(buffer[1]).toMatchObject({ text: "next text", thinking: "next thinking" });
  });

  it("can retry after a nested savepoint rollback while keeping the outer transaction open", () => {
    stream();
    db.transaction(() => {
      expect(() => db.transaction(() => {
        handle(finalEvent(), "final");
        throw new Error("inner rollback");
      })).toThrow("inner rollback");
      expect(buffer).toEqual([]);
      expect(count("event_source_receipts")).toBe(0);
      handle(finalEvent(), "final");
      expect(buffer).toEqual([]);
    });
    assertComplete();
    expect(buffer).toHaveLength(1);
    expect(transport.refresh).toHaveBeenCalledTimes(1);
  });

  it("rolls back the fact, receipt, usage and outbox if the source receipt insertion fails", () => {
    stream();
    db.exec("CREATE TRIGGER fail_source BEFORE INSERT ON event_source_receipts BEGIN SELECT RAISE(ABORT,'source failure'); END");
    expect(() => handle(finalEvent(), "final")).toThrow("source failure");
    for (const table of ["agent_events", "member_statistics", "event_usage_receipts", "event_source_receipts", "token_usage_daily", "outbox"]) expect(count(table)).toBe(0);
    expect(buffer).toEqual([]);
    expect(transport.refresh).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER fail_source");
    handle(finalEvent(), "final");
    assertComplete();
  });

  it("rejects changed raw usage, supplied model/timestamp/thinking/type and identity scope/owner/member", () => {
    stream();
    handle(finalEvent(), "final");
    const owner = { ownerKey: "mem", memberId: "mem", label: "name" };
    for (const change of [
      { usage: { inputTokens: 10, outputTokens: 3 } }, { model: "provider/model" },
      { ts: buffer[0].ts }, { thinking: "complete thinking" }, { text: "complete text" },
      { type: "agent_end" }, { extra: "different" },
    ]) {
      expect(() => persistAgentEvent("room", owner, { ...finalEvent(), ...change } as AgentHistoryEvent, "final")).toThrow("Conflicting event identity");
    }
    for (const [scope, identity] of [
      ["other", owner], ["room", { ...owner, ownerKey: "other" }], ["room", { ...owner, memberId: null }],
    ] as const) {
      expect(() => persistAgentEvent(scope, identity, finalEvent(), "final")).toThrow("Conflicting event identity");
    }
    assertComplete();
    expect(buffer).toHaveLength(1);
  });

  it("compares source JSON independent of object-key order and never guesses equal content means equal ID", () => {
    const first = persistAgentEvent("room", { ownerKey: "mem", memberId: "mem" }, finalEvent(), "a");
    const reordered = { usage: { outputTokens: 3, inputTokens: 9 }, type: "message_end" } as AgentStreamEvent;
    expect(persistAgentEvent("room", { ownerKey: "mem", memberId: "mem" }, reordered, "a")).toEqual(first);
    persistAgentEvent("room", { ownerKey: "mem", memberId: "mem" }, finalEvent(), "b");
    expect(count("agent_events")).toBe(2);
    expect(count("event_source_receipts")).toBe(2);
    expect(count("event_usage_receipts")).toBe(2);
    expect(count("outbox")).toBe(2);
  });

  it("fails closed when an existing fact has no original source receipt", () => {
    appendAgentEvent("room", { ownerKey: "mem", memberId: "mem" }, finalEvent(), "final");
    expect(() => handle(finalEvent(), "final")).toThrow("Conflicting event identity");
    expect(buffer).toEqual([]);
    expect(count("event_source_receipts")).toBe(0);
  });

  it("does not turn post-commit context observer failure into a failed write or consume a newer generation", () => {
    const errors: unknown[] = [];
    db.close();
    db = openDatabase(join(root, "test.sqlite"), { onPostCommitError: error => { errors.push(error); } });
    bindDatabase(db);
    stream();
    transport.refresh.mockImplementationOnce(() => {
      handle({ type: "message_update", text: "new generation" }, "new-delta");
      throw new Error("observer failed");
    });
    expect(() => handle(finalEvent(), "final")).not.toThrow();
    assertComplete();
    expect(errors).toEqual([expect.objectContaining({ message: "observer failed" })]);
    handle(finalEvent(), "next-final");
    expect(buffer[1]).toMatchObject({ text: "new generation" });
  });

  it("does not reset a newer stream on a replayed or failed message_start", () => {
    handle({ type: "message_start" }, "start");
    stream();
    handle({ type: "message_start" }, "start");
    expect(() => db.transaction(() => {
      handle({ type: "message_start" }, "failed-start");
      throw new Error("rollback start");
    })).toThrow("rollback start");
    handle(finalEvent(), "final");
    expect(buffer.at(-1)).toMatchObject({ text: "complete text", thinking: "complete thinking" });
    expect(buffer.map(e => e.type)).toEqual(["message_start", "message_end"]);
  });

  it("keeps post-commit tool hooks out of a rolled-back buffer and runs them once on retry", () => {
    const event: AgentStreamEvent = { type: "tool_end", toolName: "write", toolCallId: "tool", result: "ok", isError: false };
    expect(() => db.transaction(() => {
      handle(event, "end");
      throw new Error("rollback tool");
    })).toThrow("rollback tool");
    expect(buffer).toEqual([]);
    expect(transport.knowledge).not.toHaveBeenCalled();
    handle(event, "end");
    handle({ ...event }, "end");
    expect(buffer).toHaveLength(1);
    expect(transport.knowledge).toHaveBeenCalledTimes(1);
  });


  it("fingerprints raw errors before limiting so different truncated tails cannot replay as equal", () => {
    const event = { ...finalEvent(), errorMessage: "x".repeat(400) + "first" } as AgentStreamEvent;
    handle(event, "final");
    expect(() => handle({ ...event, errorMessage: "x".repeat(400) + "changed" } as AgentStreamEvent, "final")).toThrow("Conflicting event identity");
    expect(buffer).toHaveLength(1);
    expect(count("agent_events")).toBe(1);
  });

  it("adds source receipts as an ordered upgrade without rewriting existing C schema/facts", () => {
    const staged = openDatabase(join(root, "upgrade.sqlite"));
    try {
      applyStorageMigrations(staged, [baseStorageMigration, messagesMigration]);
      staged.run("INSERT INTO scopes VALUES('old','room','old',NULL)");
      staged.run("INSERT INTO agent_events VALUES('old','old','mem','mem',1,1000,'message_end',?)", JSON.stringify({ type: "message_end", text: "historical" }));
      const old = staged.get("SELECT * FROM agent_events WHERE id='old'");
      const history = staged.all("SELECT * FROM storage_schema_versions ORDER BY rowid");
      applyStorageMigrations(staged, [baseStorageMigration, messagesMigration, eventSourceMigration]);
      applyStorageMigrations(staged, [baseStorageMigration, messagesMigration, eventSourceMigration]);
      expect(staged.get("SELECT * FROM agent_events WHERE id='old'")).toEqual(old);
      expect(staged.all("SELECT * FROM storage_schema_versions ORDER BY rowid").slice(0, 2)).toEqual(history);
      expect(staged.all("SELECT * FROM event_source_receipts")).toEqual([]);
    } finally { staged.close(); }
  });


  it("keeps successive finals in one outer transaction distinct without consuming rollback recovery", () => {
    stream();
    db.transaction(() => {
      handle(finalEvent(), "first");
      handle({ type: "message_start" }, "next-start");
      handle({ type: "message_update", text: "next text", thinking: "next thinking" }, "next-delta");
      handle(finalEvent(), "second");
      expect(buffer).toEqual([]);
    });
    expect(buffer[0]).toMatchObject({ text: "complete text", thinking: "complete thinking" });
    expect(buffer[2]).toMatchObject({ text: "next text", thinking: "next thinking" });
    handle({ type: "message_update", text: "third text" }, "third-delta");
    handle(finalEvent(), "third");
    expect(buffer.at(-1)).toMatchObject({ text: "third text" });
  });

  it("retains full content and no success effects when outer COMMIT itself fails", () => {
    stream();
    db.exec("CREATE TABLE commit_guard (scope_id TEXT REFERENCES scopes(id) DEFERRABLE INITIALLY DEFERRED)");
    expect(() => db.transaction(tx => {
      handle(finalEvent(), "final");
      tx.run("INSERT INTO commit_guard VALUES('missing')");
    })).toThrow("FOREIGN KEY constraint failed");
    expect(buffer).toEqual([]);
    expect(transport.refresh).not.toHaveBeenCalled();
    for (const table of ["agent_events", "member_statistics", "event_usage_receipts", "event_source_receipts", "token_usage_daily", "outbox"]) expect(count(table)).toBe(0);
    handle(finalEvent(), "final");
    assertComplete();
  });

});
