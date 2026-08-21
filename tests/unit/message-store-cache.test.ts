import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => state.dir,
    ensureBossmodeDir: () => { mkdirSync(state.dir, { recursive: true }); },
  };
});

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { addMessage, getMessages, readAllMessages, searchMessages } from "../../src/workspace/message-store.js";
import { createTopic, addTopicMessage, readAllTopicMessages } from "../../src/workspace/topic-store.js";
import { clearJsonlCaches, jsonlCacheSize } from "../../src/workspace/jsonl-file-cache.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): void {
  const roomDir = join(state.dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["pm"],
    roomMembers: [{ id: "rm_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
  } as Room;
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
}

describe("message-store jsonl cache", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bm-msg-cache-"));
    clearJsonlCaches();
  });
  afterEach(() => {
    clearJsonlCaches();
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("second read hits cache (same array identity) until append invalidates", () => {
    writeRoom("roomA");
    addMessage("roomA", { sender: "user", content: "one", mentions: [] });
    addMessage("roomA", { sender: "pm", content: "two", mentions: [] });

    const a = readAllMessages("roomA");
    const b = readAllMessages("roomA");
    expect(a).toBe(b);
    expect(a.map((m) => m.content)).toEqual(["one", "two"]);
    expect(jsonlCacheSize()).toBe(1);

    addMessage("roomA", { sender: "user", content: "three", mentions: [] });
    const c = readAllMessages("roomA");
    expect(c).not.toBe(a);
    expect(c.map((m) => m.content)).toEqual(["one", "two", "three"]);
    expect(getMessages("roomA", { limit: 2 }).map((m) => m.content)).toEqual(["two", "three"]);
  });

  it("external file rewrite (mtime/size change) is picked up", () => {
    writeRoom("roomB");
    addMessage("roomB", { sender: "user", content: "old", mentions: [] });
    const first = readAllMessages("roomB");
    expect(first).toHaveLength(1);

    const path = join(state.dir, "rooms", "roomB", "messages.jsonl");
    // External writer — bypass addMessage invalidate.
    writeFileSync(path, JSON.stringify({ id: "msg-x", sender: "user", content: "external", mentions: [], ts: Date.now(), seq: 1 }) + "\n", "utf-8");
    // Bump mtime into the future so even coarse FS clocks see a change.
    const st = statSync(path);
    utimesSync(path, st.atime, new Date(st.mtimeMs + 2000));

    const next = readAllMessages("roomB");
    expect(next).not.toBe(first);
    expect(next.map((m) => m.content)).toEqual(["external"]);
  });

  it("rooms do not share cache entries", () => {
    writeRoom("roomX");
    writeRoom("roomY");
    addMessage("roomX", { sender: "user", content: "x-only", mentions: [] });
    addMessage("roomY", { sender: "user", content: "y-only", mentions: [] });
    expect(readAllMessages("roomX").map((m) => m.content)).toEqual(["x-only"]);
    expect(readAllMessages("roomY").map((m) => m.content)).toEqual(["y-only"]);
    expect(searchMessages("roomX", { query: "y-only" }).total).toBe(0);
    expect(searchMessages("roomY", { query: "y-only" }).total).toBe(1);
  });

  it("topic messages use the same cache + invalidate on append", () => {
    writeRoom("roomT");
    const topic = createTopic({ roomId: "roomT", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    addTopicMessage("roomT", topic.id, { sender: "user", content: "t1", mentions: [] });
    const a = readAllTopicMessages("roomT", topic.id);
    const b = readAllTopicMessages("roomT", topic.id);
    expect(a).toBe(b);
    addTopicMessage("roomT", topic.id, { sender: "pm", content: "t2", mentions: [] });
    const c = readAllTopicMessages("roomT", topic.id);
    expect(c).not.toBe(a);
    expect(c.map((m) => m.content)).toEqual(["t1", "t2"]);
  });

  it("concurrent readers never observe a partial parse", async () => {
    writeRoom("roomC");
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ id: `msg-${i}`, sender: "user", content: `c${i}`, mentions: [], ts: i, seq: i + 1 }));
    }
    const path = join(state.dir, "rooms", "roomC", "messages.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
    clearJsonlCaches();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => readAllMessages("roomC"))),
    );
    for (const r of results) {
      expect(r).toHaveLength(200);
      expect(r[0].content).toBe("c0");
      expect(r[199].content).toBe("c199");
    }
    // All hits after first fill should share identity.
    expect(new Set(results).size).toBe(1);
  });
});
