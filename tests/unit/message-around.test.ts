import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { importMessage } from "../../src/data/repositories/message-repository.js";
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });
function seedMessages(roomId: string, count: number) {
  fixture.db.run("INSERT INTO scopes VALUES(?, 'room', ?, NULL)", roomId, roomId);
  for (let i = 0; i < count; i++) importMessage(fixture.db, roomId, {
    id: `msg-${i}`, sender: "user", content: `Message ${i}`, mentions: [], ts: 1000 + i * 1000,
  });
}

describe("getMessages around", () => {
  it("returns a window centered on the target message", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-1", 50);
    const result = getMessages("around-1", { around: "msg-25", limit: 10 });
    expect(result.length).toBe(10);
    expect(result.some((m) => m.id === "msg-25")).toBe(true);
    // Window: 4 before target + target + 5 after = 10 → msg-21..msg-30
    expect(result[0].id).toBe("msg-21");
    expect(result[9].id).toBe("msg-30");
  });

  it("returns empty array when target not found", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-2", 10);
    const result = getMessages("around-2", { around: "nonexistent", limit: 10 });
    expect(result).toEqual([]);
  });

  it("handles target near the beginning", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-3", 20);
    const result = getMessages("around-3", { around: "msg-2", limit: 10 });
    expect(result.some((m) => m.id === "msg-2")).toBe(true);
    expect(result[0].id).toBe("msg-0"); // Can't go before 0
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("handles target near the end", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-4", 20);
    const result = getMessages("around-4", { around: "msg-18", limit: 10 });
    expect(result.some((m) => m.id === "msg-18")).toBe(true);
    expect(result[result.length - 1].id).toBe("msg-19"); // Can't go past end
  });
});
