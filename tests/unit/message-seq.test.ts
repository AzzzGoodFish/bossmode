import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  roomDir: (roomId: string) => join(dir, "rooms", roomId),
  getRoomsDir: () => join(dir, "rooms"),
}));

describe("message seq assignment and migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-seq-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("addMessage assigns incrementing seq starting from 1", async () => {
    const store = await import("../../src/workspace/message-store.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });

    const m1 = store.addMessage("room1", { sender: "user", content: "first", mentions: [] });
    const m2 = store.addMessage("room1", { sender: "qa", content: "second", mentions: [] });
    const m3 = store.addMessage("room1", { sender: "user", content: "third", mentions: [] });

    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(m3.seq).toBe(3);
  });

  it("addMessage continues from the highest existing seq in a legacy room", async () => {
    const store = await import("../../src/workspace/message-store.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    // Legacy message without seq
    writeFileSync(join(dir, "rooms", "room1", "messages.jsonl"),
      JSON.stringify({ id: "msg-legacy", sender: "user", content: "old", mentions: [], ts: 1 }) + "\n");

    const m = store.addMessage("room1", { sender: "user", content: "new", mentions: [] });
    // Legacy max seq is 0 (no seq field), so next is 1
    expect(m.seq).toBe(1);
  });

  it("runMessageSeqMigration backfills seq onto legacy messages and is idempotent", async () => {
    const migration = await import("../../src/workspace/message-seq-migration.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    const legacy = [
      { id: "msg-a", sender: "user", content: "one", mentions: [], ts: 1 },
      { id: "msg-b", sender: "qa", content: "two", mentions: [], ts: 2 },
      { id: "msg-c", sender: "user", content: "three", mentions: [], ts: 3 },
    ];
    writeFileSync(join(dir, "rooms", "room1", "messages.jsonl"),
      legacy.map((m) => JSON.stringify(m)).join("\n") + "\n");

    migration.runMessageSeqMigration();

    const after = readFileSync(join(dir, "rooms", "room1", "messages.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(after.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(readFileSync(join(dir, "rooms", "room1", ".seq"), "utf-8")).toBe("4");

    // Snapshot was taken
    const snapshotsDir = join(dir, "pi-agent", "runtime", ".migration-snapshots");
    expect(existsSync(snapshotsDir)).toBe(true);

    // Second run: no changes (idempotent)
    const before2 = readFileSync(join(dir, "rooms", "room1", "messages.jsonl"), "utf-8");
    migration.runMessageSeqMigration();
    const after2 = readFileSync(join(dir, "rooms", "room1", "messages.jsonl"), "utf-8");
    expect(after2).toBe(before2);
  });

  it("runMessageSeqMigration skips rooms where all messages already have seq", async () => {
    const migration = await import("../../src/workspace/message-seq-migration.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    const done = [
      { id: "msg-a", sender: "user", content: "one", mentions: [], ts: 1, seq: 5 },
      { id: "msg-b", sender: "qa", content: "two", mentions: [], ts: 2, seq: 6 },
    ];
    writeFileSync(join(dir, "rooms", "room1", "messages.jsonl"),
      done.map((m) => JSON.stringify(m)).join("\n") + "\n");

    migration.runMessageSeqMigration();

    const after = readFileSync(join(dir, "rooms", "room1", "messages.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // Seq values unchanged (not renumbered)
    expect(after.map((m) => m.seq)).toEqual([5, 6]);
  });

  it("searchMessages supports aroundSeq window", async () => {
    const store = await import("../../src/workspace/message-store.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    for (let i = 1; i <= 10; i++) {
      store.addMessage("room1", { sender: "user", content: `msg${i}`, mentions: [] });
    }

    const result = store.searchMessages("room1", { aroundSeq: 5, limit: 5 });
    expect(result.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  it("searchMessages supports type filter", async () => {
    const store = await import("../../src/workspace/message-store.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    store.addMessage("room1", { sender: "user", content: "plain", mentions: [] });
    store.addMessage("room1", { sender: "system", content: "task created", mentions: [], type: "task_event" });

    const result = store.searchMessages("room1", { type: "task_event" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe("task_event");
  });
});
