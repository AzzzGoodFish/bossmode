import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { importMessage, importMessageNextSequence } from "../../src/data/repositories/message-repository.js";
import { addMessage, readAllMessages, searchMessages } from "../../src/chat/message-store.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  fixture.db.run("INSERT INTO scopes VALUES('room1','room','room1',NULL),('dm:mem_one','dm',NULL,'mem_one'),('topic:one','topic','room1',NULL)");
});
afterEach(() => { fixture.close(); });
const input = { sender: "user", content: "next", mentions: [] };

describe("authoritative message sequences", () => {
  it.each(["room1", "dm:mem_one", "topic:one"])("assigns independent increasing sequences and resumes after reopen in %s", scope => {
    expect([addMessage(scope, input).seq, addMessage(scope, input).seq]).toEqual([1, 2]);
    fixture.reopen();
    expect(addMessage(scope, input).seq).toBe(3);
  });
  it("retains missing historical seq without renumbering and continues from imported allocation", () => {
    const raw = { ...input, id: "legacy", ts: 1 };
    importMessage(fixture.db, "room1", raw);
    importMessageNextSequence(fixture.db, "room1", 20);
    expect(readAllMessages("room1")).toEqual([raw]);
    expect(addMessage("room1", input).seq).toBe(20);
    expect(readAllMessages("room1")[0]).not.toHaveProperty("seq");
  });
  it("preserves supplied historical sequences and never rewinds on lower allocation imports", () => {
    for (const seq of [5, 6]) importMessage(fixture.db, "room1", { ...input, id: `old-${seq}`, ts: seq, seq });
    importMessageNextSequence(fixture.db, "room1", 2);
    expect(readAllMessages("room1").map(m => m.seq)).toEqual([5, 6]);
    expect(addMessage("room1", input).seq).toBe(7);
  });
  it("does not invent sequence history when there was no recorded allocation", () => {
    importMessage(fixture.db, "room1", { ...input, id: "legacy", ts: 1 });
    expect(addMessage("room1", input).seq).toBe(1);
  });
  it("supports centered sequence windows", () => {
    for (let i = 1; i <= 10; i++) addMessage("room1", { ...input, content: `msg${i}` });
    expect(searchMessages("room1", { aroundSeq: 5, limit: 5 }).messages.map(m => m.seq)).toEqual([3, 4, 5, 6, 7]);
  });
  it("filters types without mixing plain messages", () => {
    addMessage("room1", input);
    addMessage("room1", { ...input, sender: "system", type: "task_event" });
    expect(searchMessages("room1", { type: "task_event" })).toMatchObject({ total: 1, messages: [{ type: "task_event" }] });
  });
});
