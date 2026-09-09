import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { conversationsFixture } from "./unit/core-conversations-fixture.js";

// Mock getBossmodeDir to use temp dir
let tempDir: string;
let fixture: ReturnType<typeof conversationsFixture>;

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

describe("room-store", () => {
  let roomStore: typeof import("../src/workspace/room-store.js");
  let messageStore: typeof import("../src/workspace/message-store.js");

  beforeEach(async () => {
    vi.resetModules();
    tempDir = process.env.BOSSMODE_TEST_ROOT!;
    const { conversationsFixture: createFixture } = await import("./unit/core-conversations-fixture.js");
    fixture = createFixture();
    tempDir = fixture.root;
    mkdirSync(join(tempDir, "agents"), { recursive: true });
    for (const agent of ["pm", "dev", "qa", "developer", "architect"]) {
      writeFileSync(join(tempDir, "agents", `${agent}.md`), `---\nname: ${agent}\n---\n${agent}`, "utf-8");
    }
    roomStore = await import("../src/workspace/room-store.js");
    messageStore = await import("../src/workspace/message-store.js");
  });

  afterEach(() => {
    fixture.close();
  });

  describe("createRoom", () => {
    it("should create a room with proper structure", () => {
      const room = roomStore.createRoom("test room", "/tmp/project", drafts(["pm", "dev"]));

      expect(room.id).toBeTruthy();
      expect(room.name).toBe("test room");
      expect(room.cwd).toBeUndefined(); // batch 7 P3: rooms no longer bind a cwd
      expect(room.members).toEqual(["pm", "dev"]);
      expect(room.docsPath).toBe("test-room/");
      expect(room.createdAt).toBeGreaterThan(0);

      // Metadata and cursors are DB authority; only file-asset directories are created
      const roomDir = join(tempDir, "rooms", room.id);
      expect(existsSync(join(roomDir, "room.json"))).toBe(false);
      expect(existsSync(join(roomDir, "messages.jsonl"))).toBe(false);
      expect(existsSync(join(roomDir, "cursors.json"))).toBe(false);
      expect(existsSync(join(tempDir, "memory", "projects", "test-room"))).toBe(true);
    });

    it("should initialize cursors to null for all members", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm", "dev", "qa"]));
      const roomMembers = roomStore.getRoomMembers(room.id);
      const cursors = roomStore.getCursors(room.id);
      expect(roomMembers.map((m) => m.name)).toEqual(["pm", "dev", "qa"]);
      expect(Object.keys(cursors).sort()).toEqual(roomMembers.map((m) => m.id).sort());
      expect(Object.values(cursors)).toEqual([null, null, null]);
    });

    it("rejects duplicate room-local member names", () => {
      expect(() => roomStore.createRoom("test", "/tmp", drafts(["pm", "pm"]))).toThrow(/Duplicate member name/);
    });

    it("rejects invalid room-local member names", () => {
      expect(() => roomStore.createRoom("test", "/tmp", drafts(["pm", "bad name"]))).toThrow(/member name may contain/);
    });

    it("accepts an explicit normalized docsPath and can clear legacy bindings", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]), undefined, { docsPath: "bossmode" });
      expect(room.docsPath).toBe("bossmode/");
      expect(existsSync(join(tempDir, "memory", "projects", "bossmode"))).toBe(true);
      const cleared = roomStore.updateRoomDocsPath(room.id, null);
      expect(cleared?.docsPath).toBeUndefined();
    });
  });

  describe("getRoom", () => {
    it("should return room by id", () => {
      const created = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const fetched = roomStore.getRoom(created.id);
      expect(fetched).toEqual(created);
    });

    it("should return null for non-existent room", () => {
      expect(roomStore.getRoom("nonexistent")).toBeNull();
    });
  });

  describe("listRooms", () => {
    it("should list all rooms", () => {
      roomStore.createRoom("room 1", "/tmp/a", drafts(["pm"]));
      roomStore.createRoom("room 2", "/tmp/b", drafts(["dev"]));
      roomStore.createRoom("room 3", "/tmp/c", drafts(["qa"]));

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
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));

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
      const room = roomStore.createRoom("test", "/tmp", drafts([]));

      for (let i = 0; i < 10; i++) {
        messageStore.addMessage(room.id, { sender: "user", content: `msg ${i}`, mentions: [] });
      }

      const messages = messageStore.getMessages(room.id, { limit: 3 });
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("msg 7"); // Last 3
      expect(messages[2].content).toBe("msg 9");
    });

    it("caps runtime failure views without truncating imported database facts", async () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const longFailure = `Member "pm" request failed. Error: ${"x".repeat(5_763)}`;
      const stored = messageStore.addMessage(room.id, { sender: "system", content: longFailure, mentions: [] });

      expect(Array.from(stored.content)).toHaveLength(300);
      expect(stored.content.endsWith("…")).toBe(true);
      const path = join(tempDir, "rooms", room.id, "messages.jsonl");
      expect(existsSync(path)).toBe(false);
      expect(fixture.db.get<{content:string}>("SELECT content FROM messages WHERE id=?",stored.id)?.content).toBe(stored.content);

      const legacyFailure = { id: "legacy", ts: 1, sender: "system", content: longFailure, mentions: [] };
      const userMessage = { id: "user", ts: 2, sender: "user", content: "u".repeat(5_763), mentions: [] };
      const memberMessage = { id: "member", ts: 3, sender: "pm", content: "r".repeat(5_763), mentions: [] };
      writeFileSync(path, [legacyFailure, userMessage, memberMessage].map((message) => JSON.stringify(message)).join("\n") + "\n", "utf-8");

      const {importMessage}=await import("../src/storage/messages-import.js");
      const legacyRoom=roomStore.createRoom("legacy", "/tmp", drafts([]));
      for(const message of [legacyFailure,userMessage,memberMessage]) importMessage(fixture.db,legacyRoom.id,message);
      const messages = messageStore.getMessages(legacyRoom.id);
      expect(fixture.db.get<{content:string}>("SELECT content FROM messages WHERE scope_id=? AND id='legacy'",legacyRoom.id)?.content).toBe(longFailure);
      expect(messageStore.getMessages(room.id)).toHaveLength(1); // retired file is inert
      expect(Array.from(messages[0].content)).toHaveLength(300);
      expect(messages[0].content.endsWith("…")).toBe(true);
      expect(messages[1].content).toHaveLength(5_763);
      expect(messages[2].content).toHaveLength(5_763);
    });

    it("should return messages before a given ID", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts([]));

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
      const room = roomStore.createRoom("test", "/tmp", drafts([]));

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
      const room = roomStore.createRoom("test", "/tmp", drafts([]));
      messageStore.addMessage(room.id, { sender: "user", content: "msg", mentions: [] });

      const all = messageStore.getMessagesSince(room.id, null);
      expect(all).toHaveLength(1);
    });
  });

  describe("cursors", () => {
    it("should set and read cursor", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.setCursor(room.id, "pm", msg.id);

      const cursors = roomStore.getCursors(room.id);
      expect(cursors.pm).toBe(msg.id);
    });

    it("should allow resetting cursor to null", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.setCursor(room.id, "pm", msg.id);
      roomStore.setCursor(room.id, "pm", null);

      const cursors = roomStore.getCursors(room.id);
      expect(cursors.pm).toBeNull();
    });
  });

  describe("roomMembers", () => {
    it("derives legacy name-only records from room data without reading the old member file", () => {
      writeFileSync(join(tempDir, "members.json"), JSON.stringify([
        { id: "legacy-qa", name: "qa", agent: "developer", model: "retired-model", credentialId: "retired-credential", skills: ["retired-skill"] },
      ]));
      const room = roomStore.createRoom("legacy", "/tmp", drafts(["qa"]));
      delete room.roomMembers;
      room.memberOverrides = { qa: { model: "room-model" } };
      const [member] = roomStore.getRoomMembersFromRoom(room);
      expect(member).toMatchObject({ name: "qa", sourceAgent: "qa", config: { model: "room-model" } });
      expect(member.sourceMemberId).toBeUndefined();
      expect(member.config?.credentialId).toBeUndefined();
      expect(member.config?.skills).toBeUndefined();
      writeFileSync(join(tempDir, "members.json"), "invalid retired data");
      expect(roomStore.getRoomMembersFromRoom(room)[0].config).toEqual({ model: "room-model" });
    });

    it("derives renamed global members from the DB without changing room member IDs", async () => {
      const member = { id: "mem_qa" };
      fixture.member(member.id, "qa-before");
      const room = roomStore.createRoom("test", "/tmp", []);
      roomStore.stampGlobalMemberIds(room.id, [member.id]);
      fixture.member(member.id, "qa-after");
      expect(roomStore.getRoomMembers(room.id)).toMatchObject([{ id: member.id, name: "qa-after" }]);
      expect(roomStore.findRoomMemberByName(room.id, "qa-before")).toBeNull();
    });

  });

  describe("addRoomMemberFromAgent", () => {
    function writeAgent(name: string): void {
      mkdirSync(join(tempDir, "agents"), { recursive: true });
      writeFileSync(join(tempDir, "agents", `${name}.md`), `---\nname: ${name}\n---\n${name} prompt\n`, "utf-8");
    }

    it("adds multiple differently named members from the same Agent", () => {
      writeAgent("developer");
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const first = roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" });
      const second = roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-b" });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const members = roomStore.getRoomMembers(room.id).filter((member) => member.sourceAgent === "developer");
      expect(members.map((member) => member.name)).toEqual(["dev-a", "dev-b"]);
      expect(new Set(members.map((member) => member.id)).size).toBe(2);
      expect(roomStore.getRoom(room.id)!.members).toEqual(["pm", "dev-a", "dev-b"]);
    });

    it("rejects duplicate member names but allows duplicate sourceAgent", () => {
      writeAgent("developer");
      const room = roomStore.createRoom("test", "/tmp", drafts([]));
      expect(roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" }).ok).toBe(true);
      const duplicate = roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" });
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.code).toBe("duplicate");
    });

    it("does not inherit legacy global member config by new member name", () => {
      writeAgent("developer");
      writeFileSync(join(tempDir, "members.json"), JSON.stringify([
        { id: "legacy-dev", name: "dev-a", agent: "qa", runtime: "pi-cli", model: "legacy-model", thinkingLevel: "high" },
      ]));
      const room = roomStore.createRoom("test", "/tmp", drafts([]));
      const added = roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" });
      expect(added.ok).toBe(true);
      const member = roomStore.findRoomMemberByName(room.id, "dev-a")!;
      expect(member.sourceAgent).toBe("developer");
      expect(member.sourceMemberId).toBeUndefined();
      expect(member.migratedFrom).toBeUndefined();
      expect(member.config?.model).toBeUndefined();
      expect(member.config?.thinkingLevel).toBeUndefined();
    });
  });

  describe("addMember", () => {
    it("should add new member to room", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const result = roomStore.addMember(room.id, "qa");
      expect(result).toBe(true);

      const updated = roomStore.getRoom(room.id);
      expect(updated!.members).toContain("qa");
    });

    it("should reject duplicate member", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      expect(roomStore.addMember(room.id, "pm")).toBe(false);
    });

    it("should initialize new member cursor to latest message", () => {
      const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
      const msg = messageStore.addMessage(room.id, { sender: "user", content: "hi", mentions: [] });

      roomStore.addMember(room.id, "qa");
      const cursors = roomStore.getCursors(room.id);
      const qa = roomStore.findRoomMemberByName(room.id, "qa")!;
      expect(cursors[qa.id]).toBe(msg.id);
    });
  });
});
