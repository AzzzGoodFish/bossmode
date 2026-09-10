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
import { loadScopeMessages, parseReplyToParam } from "../../src/engine/tools.js";
import { wrapRoomContextMessage } from "../../src/engine/message-envelope.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const members = ["pm"].map(name => createMember({ name }));
  const room: Room = { id: roomId, name: "R", members: members.map(m => m.name),
    globalMemberIds: members.map(m => m.id), createdAt: 1 };
  new ConversationsRepository().upsertRoom(room);
  return room;
}

describe("topic scope reply_to + envelope lookup", () => {
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

  it("parseReplyToParam hits a topic-scope seq", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fresh",
    });
    addTopicMessage("roomA", topic.id, { sender: "user", content: "please fix auth", mentions: [] });
    const scope = loadScopeMessages(`topic:${topic.id}`);
    const hit = parseReplyToParam("msg:#1", scope);
    expect(hit.ok).toBe(true);
    if (hit.ok && hit.replyTo) {
      expect(hit.replyTo.seq).toBe(1);
      expect(hit.replyTo.messageId).toBe(scope[0].id);
    }
    const miss = parseReplyToParam("msg:#99", scope);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toMatch(/not found/i);
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
