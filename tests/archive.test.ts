import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { coreFixture } from "./helpers/core-fixture.js";
let fixture: ReturnType<typeof coreFixture>;

let tempDir: string;
let database: import("../src/data/database.js").Database;

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("archive", () => {
  let roomStore: typeof import("../src/workspace/room-store.js");
  let messageStore: typeof import("../src/workspace/message-store.js");
  let archiveStore: typeof import("../src/workspace/archive-store.js");

  beforeEach(async () => {
    vi.resetModules();
    const { coreFixture } = await import("./helpers/core-fixture.js");
    fixture = coreFixture();
    tempDir = fixture.root;
    database = fixture.db;
    roomStore = await import("../src/workspace/room-store.js");
    messageStore = await import("../src/workspace/message-store.js");
    archiveStore = await import("../src/workspace/archive-store.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture?.close();
  });

  it("rolls back archive publication and pruning together", () => {
    const room = roomStore.createRoom("test", "/tmp", []);
    messageStore.addMessage(room.id, { sender: "user", content: "kept on failure", mentions: [] });
    database.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'injected prune failure'); END");
    expect(() => archiveStore.archiveMessages(room.id, 0)).toThrow("injected prune failure");
    expect(messageStore.getMessages(room.id)).toHaveLength(1);
    expect(archiveStore.listArchives(room.id)).toEqual([]);
    expect(database.all("SELECT * FROM message_archive_entries")).toEqual([]);
  });

  it("keeps distinct same-millisecond archives and ignores poison retired files", () => {
    const room = roomStore.createRoom("test", "/tmp", []);
    const dir = join(tempDir, "rooms", room.id, "archives");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "99.summary.json"), "invalid legacy data");
    vi.spyOn(Date, "now").mockReturnValue(100);
    for (let i = 0; i < 2; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: String(i), mentions: [] });
      expect(archiveStore.archiveMessages(room.id, 0)?.kept).toEqual([]);
    }
    expect(archiveStore.listArchives(room.id)).toEqual([
      { timestamp: 101, hasMessages: true, hasSummary: false },
      { timestamp: 100, hasMessages: true, hasSummary: false },
    ]);
    expect(archiveStore.readArchiveSummary(room.id, 99)).toBeNull();
    expect(() => archiveStore.archiveMessages(room.id, -1)).toThrow("keep count");
  });

  it("should archive old messages, keeping last N", () => {
    const room = roomStore.createRoom("test", "/tmp", []);

    // Add 60 messages
    for (let i = 0; i < 60; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
    }

    const result = archiveStore.archiveMessages(room.id, 50);
    expect(result).not.toBeNull();
    expect(result!.archived).toHaveLength(10);
    expect(result!.kept).toHaveLength(50);

    // Verify the authoritative current-message query now returns only 50
    const remaining = messageStore.getMessages(room.id, { limit: 100 });
    expect(remaining).toHaveLength(50);
    expect(remaining[0].content).toBe("msg 10"); // First kept
    expect(remaining[49].content).toBe("msg 59"); // Last kept
  });

  it("should return null if nothing to archive", () => {
    const room = roomStore.createRoom("test", "/tmp", []);

    for (let i = 0; i < 30; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
    }

    const result = archiveStore.archiveMessages(room.id, 50);
    expect(result).toBeNull();
  });

  it("should save and read archive summary", () => {
    const room = roomStore.createRoom("test", "/tmp", []);
    const msgs = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] }));
    }

    archiveStore.saveArchiveSummary(room.id, "Test summary", msgs, Date.now());

    const archives = archiveStore.listArchives(room.id);
    expect(archives.length).toBeGreaterThan(0);

    const summary = archiveStore.readArchiveSummary(room.id, archives[0].timestamp);
    expect(summary).not.toBeNull();
    expect(summary!.summary).toBe("Test summary");
    expect(summary!.archivedCount).toBe(5);
  });

  it("should read archived messages", () => {
    const room = roomStore.createRoom("test", "/tmp", []);

    for (let i = 0; i < 60; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
    }

    archiveStore.archiveMessages(room.id, 50);

    const archives = archiveStore.listArchives(room.id);
    expect(archives.length).toBe(1);

    const archived = archiveStore.readArchiveMessages(room.id, archives[0].timestamp);
    expect(archived).toHaveLength(10);
    expect(archived[0].content).toBe("msg 0");
    expect(archived[9].content).toBe("msg 9");
  });

  it("should list archives newest first", () => {
    const room = roomStore.createRoom("test", "/tmp", []);

    // Create two archives
    for (let i = 0; i < 110; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
    }

    archiveStore.archiveMessages(room.id, 50); // Archives 60 messages

    // Add more and archive again
    for (let i = 0; i < 60; i++) {
      messageStore.addMessage(room.id, { sender: "user", content: `batch2 ${i}`, mentions: [] });
    }

    archiveStore.archiveMessages(room.id, 50);

    const archives = archiveStore.listArchives(room.id);
    expect(archives.length).toBe(2);
    expect(archives[0].timestamp).toBeGreaterThan(archives[1].timestamp);
  });
});
