import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { importMessage } from "../../src/data/repositories/message-repository.js";
import type { RoomMessage } from "../../src/kernel/types.js";
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });

let roomSeq = 0;
function makeRoomId() { return `room-search-${++roomSeq}`; }

function writeMessages(roomId: string, messages: object[]) {
  fixture.db.run("INSERT INTO scopes VALUES(?, 'room', ?, NULL)", roomId, roomId);
  for (const message of messages) importMessage(fixture.db, roomId, message as RoomMessage);
}

describe("message-store searchMessages", () => {
  it("keyword search is case-insensitive", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "The Quick Brown Fox", ts: 1000, mentions: [] },
      { id: "m2", sender: "pm", content: "something else", ts: 2000, mentions: [] },
    ]);
    const result = searchMessages(rid, { query: "quick brown" });
    expect(result.total).toBe(1);
    expect(result.messages[0].id).toBe("m1");
  });

  it("sender filter is exact match", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "hello", ts: 1000, mentions: [] },
      { id: "m2", sender: "pm", content: "hello", ts: 2000, mentions: [] },
    ]);
    const result = searchMessages(rid, { from: "pm" });
    expect(result.total).toBe(1);
    expect(result.messages[0].sender).toBe("pm");
  });

  it("time range after/before filters", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "old", ts: 1000, mentions: [] },
      { id: "m2", sender: "fish", content: "mid", ts: 5000, mentions: [] },
      { id: "m3", sender: "fish", content: "new", ts: 9000, mentions: [] },
    ]);
    const result = searchMessages(rid, { after: 2000, before: 8000 });
    expect(result.total).toBe(1);
    expect(result.messages[0].id).toBe("m2");
  });

  it("combined query + from filter", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "plan for next week", ts: 1000, mentions: [] },
      { id: "m2", sender: "pm", content: "plan for next week", ts: 2000, mentions: [] },
      { id: "m3", sender: "fish", content: "unrelated", ts: 3000, mentions: [] },
    ]);
    const result = searchMessages(rid, { query: "plan", from: "fish" });
    expect(result.total).toBe(1);
    expect(result.messages[0].id).toBe("m1");
  });

  it("total is not affected by limit", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`, sender: "fish", content: `message ${i}`, ts: i * 100, mentions: [],
    }));
    writeMessages(rid, msgs);
    const result = searchMessages(rid, { query: "message", limit: 5 });
    expect(result.total).toBe(20);
    expect(result.messages.length).toBe(5);
  });

  it("offset and limit provide pagination", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, sender: "fish", content: "x", ts: i * 100, mentions: [],
    }));
    writeMessages(rid, msgs);
    const page1 = searchMessages(rid, { query: "x", limit: 3, offset: 0 });
    const page2 = searchMessages(rid, { query: "x", limit: 3, offset: 3 });
    expect(page1.messages.length).toBe(3);
    expect(page2.messages.length).toBe(3);
    expect(page1.messages.map((m) => m.id)).not.toEqual(page2.messages.map((m) => m.id));
  });

  it("empty results when no match", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "hello", ts: 1000, mentions: [] },
    ]);
    const result = searchMessages(rid, { query: "zzz_not_found" });
    expect(result.total).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("limit is capped at 500", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    const msgs = Array.from({ length: 600 }, (_, i) => ({
      id: `m${i}`, sender: "fish", content: "x", ts: i, mentions: [],
    }));
    writeMessages(rid, msgs);
    const result = searchMessages(rid, { limit: 1000 });
    expect(result.messages.length).toBe(500);
  });

  it("offset beyond total returns empty messages", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "x", ts: 1000, mentions: [] },
    ]);
    const result = searchMessages(rid, { offset: 999 });
    expect(result.messages).toEqual([]);
    expect(result.total).toBe(1);
  });

  it("results are sorted newest first", async () => {
    const { searchMessages } = await import("../../src/workspace/message-store.js");
    const rid = makeRoomId();
    writeMessages(rid, [
      { id: "m1", sender: "fish", content: "x", ts: 1000, mentions: [] },
      { id: "m2", sender: "fish", content: "x", ts: 3000, mentions: [] },
      { id: "m3", sender: "fish", content: "x", ts: 2000, mentions: [] },
    ]);
    const result = searchMessages(rid, { query: "x" });
    const timestamps = result.messages.map((m) => m.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });
});
