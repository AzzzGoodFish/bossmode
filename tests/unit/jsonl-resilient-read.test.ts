/**
 * JSONL read-path line-level resilience (0.19.5).
 * A single corrupt/truncated line must not take down room message reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

function goodMsg(id: string, content: string, seq: number) {
  return JSON.stringify({
    id,
    seq,
    ts: 1_700_000_000_000 + seq,
    sender: "user",
    content,
    type: "message",
  });
}

describe("jsonl resilient read", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-jsonl-"));
    mkdirSync(join(dir, "rooms", "room-a"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMessages(...lines: string[]) {
    writeFileSync(join(dir, "rooms", "room-a", "messages.jsonl"), lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  }

  it("empty file returns []", async () => {
    writeMessages();
    const { getMessages, readAllMessages } = await import("../../src/workspace/message-store.js");
    expect(getMessages("room-a")).toEqual([]);
    expect(readAllMessages("room-a")).toEqual([]);
  });

  it("all-good file returns every message", async () => {
    writeMessages(goodMsg("m1", "hello", 1), goodMsg("m2", "world", 2), goodMsg("m3", "!", 3));
    const { getMessages, readAllMessages, getLatestMessageId } = await import("../../src/workspace/message-store.js");
    const all = readAllMessages("room-a");
    expect(all.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(getMessages("room-a").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(getLatestMessageId("room-a")).toBe("m3");
  });

  it("trailing truncated line is skipped; earlier messages still load (lhy disk-full case)", async () => {
    // 51-byte-ish unterminated string fragment, same class of failure as production
    const truncated = '{"id":"m-bad","sender":"jarvy","content":"redis is';
    writeMessages(goodMsg("m1", "first", 1), goodMsg("m2", "second", 2), truncated);
    const { getMessages, readAllMessages, getMessagesSince, getLatestMessageId } = await import("../../src/workspace/message-store.js");

    const all = readAllMessages("room-a");
    expect(all.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(getMessages("room-a").map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(getMessagesSince("room-a", null).map((m) => m.id)).toEqual(["m1", "m2"]);
    // Latest-id walks past the corrupt tail
    expect(getLatestMessageId("room-a")).toBe("m2");
  });

  it("middle corrupt line is skipped; neighbors remain in order", async () => {
    writeMessages(
      goodMsg("m1", "a", 1),
      "{not-json",
      goodMsg("m2", "b", 2),
      "",
      goodMsg("m3", "c", 3),
    );
    const { readAllMessages, getMessages, searchMessages } = await import("../../src/workspace/message-store.js");
    expect(readAllMessages("room-a").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(getMessages("room-a").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(searchMessages("room-a", { query: "b" }).messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("agent-events loadEventsFromDisk also skips corrupt lines", async () => {
    const eventsDir = join(dir, "rooms", "room-a", "agent-events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, "pm.jsonl"),
      [
        JSON.stringify({ type: "agent_start", ts: 1 }),
        '{"type":"tool_start","ts":2,"partial',
        JSON.stringify({ type: "agent_end", ts: 3 }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const { loadEventsFromDisk } = await import("../../src/engine/event-handler.js");
    const events = loadEventsFromDisk("room-a", "pm");
    expect(events.map((e: any) => e.type)).toEqual(["agent_start", "agent_end"]);
  });

  it("parseJsonlLines helper: middle/trailing/all-good/empty", async () => {
    const { parseJsonlLines } = await import("../../src/shared/jsonl.js");
    expect(parseJsonlLines("", { category: "test" })).toEqual([]);
    expect(parseJsonlLines('{"a":1}\n{"a":2}\n', { category: "test" })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonlLines('{"a":1}\nNOPE\n{"a":3}\n', { category: "test" })).toEqual([{ a: 1 }, { a: 3 }]);
    expect(parseJsonlLines('{"a":1}\n{"a":2,"unterminated', { category: "test" })).toEqual([{ a: 1 }]);
  });
});
