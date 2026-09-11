import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { createMember } from "../../src/workspace/member-registry.js";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;
const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
  readConfig: () => ({ runtime: {}, defaults: {} }),
  writeConfig: vi.fn(),
}));

import { createTopic, addTopicMessage } from "../../src/workspace/topic-store.js";
import { loadScopeMessages, handleToolCallback } from "../../src/engine/tools.js";
import { wrapRoomContextMessage } from "../../src/engine/message-envelope.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const members = ["pm"].map(name => createMember({ name }));
  const room: Room = { id: roomId, name: "R", members: members.map(m => m.name),
    globalMemberIds: members.map(m => m.id), createdAt: 1 };
  new ConversationsRepository().upsertRoom(room);
  return room;
}

describe("topic scope stored replies + envelope lookup", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
  });
  afterEach(() => {
    fixture.close();
  });

  it("loadScopeMessages(topic:) returns topic SQL history, not the parent room", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fresh",
    });
    addTopicMessage("roomA", topic.id, { sender: "user", content: "please fix auth", mentions: [] });
    addTopicMessage("roomA", topic.id, { sender: "developer", content: "on it", mentions: [] });

    const loaded = loadScopeMessages(`topic:${topic.id}`);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].content).toBe("please fix auth");
    expect(loadScopeMessages("roomA")).toHaveLength(0);
  });

  it("queries a stored topic reply across the page window and degrades a missing target", async () => {
    const room = writeRoom("roomA");
    const topic = createTopic({ roomId: room.id, title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    const target = addTopicMessage(room.id, topic.id, { sender: "user", content: "please fix auth", mentions: [] });
    const replyTo = { seq: target.seq!, messageId: target.id };
    addTopicMessage(room.id, topic.id, { sender: "pm", content: "patched", mentions: [], replyTo });
    const scope = `topic:${topic.id}`;
    const query = () => handleToolCallback("query_room_messages", scope, "pm", { limit: 1 }, { memberId: room.globalMemberIds![0] });
    expect(await query()).toMatchObject([{ content: "patched", replyTo: { ...replyTo, excerpt: "please fix auth" } }]);
    addTopicMessage(room.id, topic.id, { sender: "pm", content: "missing target", mentions: [], replyTo: { seq: 99, messageId: "missing" } });
    expect(await query()).toMatchObject([{ replyTo: { seq: 99, messageId: "missing", unavailable: true } }]);
  });

  it("envelope quote shows the topic target excerpt", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fresh",
    });
    const first = addTopicMessage("roomA", topic.id, { sender: "user", content: "please fix auth", mentions: [] });
    const reply = addTopicMessage("roomA", topic.id, {
      sender: "developer",
      content: "patched",
      mentions: [],
      replyTo: { seq: first.seq!, messageId: first.id },
    });
    const scope = loadScopeMessages(`topic:${topic.id}`);
    const byId = new Map(scope.map((m) => [m.id, m]));
    const text = wrapRoomContextMessage(reply, "R", "member", (ref) => byId.get(ref.messageId));
    expect(text).toContain("In reply to msg:#1");
    expect(text).toContain("please fix auth");
    expect(text).toContain("patched");
  });
});
