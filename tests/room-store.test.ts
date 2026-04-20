import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock getBossmodeDir to use temp dir
let tempDir: string;

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("room-store", () => {
  let roomStore: typeof import("../src/workspace/room-store.js");
  let messageStore: typeof import("../src/workspace/message-store.js");

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-room-test-"));
    // Re-import to pick up new tempDir
    vi.resetModules();
    roomStore = await import("../src/workspace/room-store.js");
    messageStore = await import("../src/workspace/message-store.js");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createRoom", () => {
    it("should create a room with proper structure", () => {
      const room = roomStore.createRoom("test room", "/tmp/project", ["pm", "dev"]);

      expect(room.id).toBeTruthy();
      expect(room.name).toBe("test room");
      expect(room.cwd).toBe("/tmp/project");
      expect(room.members).toEqual(["pm", "dev"]);
      expect(room.createdAt).toBeGreaterThan(0);

      // Verify files created
      const roomDir = join(tempDir, "rooms", room.id);
      expect(existsSync(join(roomDir, "room.json"))).toBe(true);
      expect(existsSync(join(roomDir, "messages.jsonl"))).toBe(true);
      expect(existsSync(join(roomDir, "cursors.json"))).toBe(true);
    });

    it("should initialize cursors to null for all members", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm", "dev", "qa"]);
      const cursors = roomStore.getCursors(room.id);
      expect(cursors).toEqual({ pm: null, dev: null, qa: null });
    });
  });

  describe("getRoom", () => {
    it("should return room by id", () => {
      const created = roomStore.createRoom("test", "/tmp", ["pm"]);
      const fetched = roomStore.getRoom(created.id);
      expect(fetched).toEqual(created);
    });

    it("should return null for non-existent room", () => {
      expect(roomStore.getRoom("nonexistent")).toBeNull();
    });
  });

  describe("listRooms", () => {
    it("should list all rooms", () => {
      roomStore.createRoom("room 1", "/tmp/a", ["pm"]);
      roomStore.createRoom("room 2", "/tmp/b", ["dev"]);
      roomStore.createRoom("room 3", "/tmp/c", ["qa"]);

      const rooms = roomStore.listRooms();
      expect(rooms).toHaveLength(3);
      const names = rooms.map((r) => r.name).sort();
      expect(names).toEqual(["room 1", "room 2", "room 3"]);
    });

    it("should return empty array when no rooms exist", () => {
      expect(roomStore.listRooms()).toEqual([]);
    });
  });

  describe("messages", () => {
    it("should add and retrieve messages", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);

      const msg1 = messageStore.addMessage(room.id, {
        sender: "user",
        content: "Hello @pm",
        mentions: ["pm"],
      });

      const msg2 = messageStore.addMessage(room.id, {
        sender: "pm",
        content: "Hi there!",
        mentions: [],
      });

      expect(msg1.id).toBeTruthy();
      expect(msg1.sender).toBe("user");
      expect(msg1.ts).toBeGreaterThan(0);

      const messages = messageStore.getMessages(room.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("Hello @pm");
      expect(messages[1].content).toBe("Hi there!");
    });

    it("should respect limit parameter", () => {
      const room = roomStore.createRoom("test", "/tmp", []);

      for (let i = 0; i < 10; i++) {
        messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
      }

      const messages = messageStore.getMessages(room.id, { limit: 3 });
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("msg 7"); // Last 3
      expect(messages[2].content).toBe("msg 9");
    });

    it("should return messages before a given ID", () => {
      const room = roomStore.createRoom("test", "/tmp", []);

      const msgs = [];
      for (let i = 0; i < 5; i++) {
        msgs.push(messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] }));
      }

      const before = messageStore.getMessages(room.id, { before: msgs[3].id });
      expect(before).toHaveLength(3);
      expect(before[2].content).toBe("msg 2");
    });

    it("should return empty array for non-existent room", () => {
      expect(messageStore.getMessages("nonexistent")).toEqual([]);
    });
  });

  describe("getMessagesSince", () => {
    it("should return messages after cursor", () => {
      const room = roomStore.createRoom("test", "/tmp", []);

      const msgs = [];
      for (let i = 0; i < 5; i++) {
        msgs.push(messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] }));
      }

      const since = messageStore.getMessagesSince(room.id, msgs[2].id);
      expect(since).toHaveLength(2);
      expect(since[0].content).toBe("msg 3");
      expect(since[1].content).toBe("msg 4");
    });

    it("should return all messages when cursor is null", () => {
      const room = roomStore.createRoom("test", "/tmp", []);
      messageStore.addMessage(room.id, { sender: "user", content: "msg", mentions: [] });

      const all = messageStore.getMessagesSince(room.id, null);
      expect(all).toHaveLength(1);
    });
  });

  describe("cursors", () => {
    it("should set and read cursor", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.setCursor(room.id, "pm", msg.id);

      const cursors = roomStore.getCursors(room.id);
      expect(cursors.pm).toBe(msg.id);
    });

    it("should allow resetting cursor to null", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.setCursor(room.id, "pm", msg.id);
      roomStore.setCursor(room.id, "pm", null);

      const cursors = roomStore.getCursors(room.id);
      expect(cursors.pm).toBeNull();
    });
  });

  describe("addMember", () => {
    it("should add new member to room", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);
      const result = roomStore.addMember(room.id, "qa");
      expect(result).toBe(true);

      const updated = roomStore.getRoom(room.id);
      expect(updated!.members).toContain("qa");
    });

    it("should reject duplicate member", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);
      expect(roomStore.addMember(room.id, "pm")).toBe(false);
    });

    it("should initialize new member cursor to latest message", () => {
      const room = roomStore.createRoom("test", "/tmp", ["pm"]);
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.addMember(room.id, "qa");
      const cursors = roomStore.getCursors(room.id);
      expect(cursors.qa).toBe(msg.id);
    });
  });
});
