import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { createMember } from "../../src/workspace/member-registry.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

import { createTopic, readAllTopicMessages, resolveChatScopeRoomId } from "../../src/workspace/topic-store.js";
import { handleToolCallback } from "../../src/engine/tools.js";
import { processAgentAttachments } from "../../src/engine/agent-attachments.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const members = ["alice", "bob"].map(name => createMember({ name }));
  const room: Room = { id: roomId, name: "R", members: members.map(m => m.name),
    globalMemberIds: members.map(m => m.id), createdAt: 1 };
  new ConversationsRepository().upsertRoom(room);
  return room;
}

describe("topic chat scope: mentions / need_response / attachments", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
  });
  afterEach(() => {
    fixture.close();
  });

  it("resolveChatScopeRoomId maps topic: to parent", () => {
    const room = writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    expect(resolveChatScopeRoomId(`topic:${topic.id}`)).toBe("roomA");
    expect(resolveChatScopeRoomId("dm:mem_x")).toBeNull();
  });

  it("chat in topic: persists @ mentions and need_response from parent roster", async () => {
    const room = writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    const scope = `topic:${topic.id}`;
    const result = await handleToolCallback("chat", scope, "alice", {
      message: "@bob please ack NR",
      need_response: ["bob"],
    }, { memberId: room.globalMemberIds![0] });
    expect(result).toMatchObject({ ok: true });
    const msgs = readAllTopicMessages("roomA", topic.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].mentions).toContain("bob");
    expect(msgs[0].needResponse).toEqual(["bob"]);
  });

  it("attachments on topic: land in the parent room store", async () => {
    const room = writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    const src = join(state.dir, "members", room.globalMemberIds![0], "topic-attach.txt");
    writeFileSync(src, "hello-attach");
    const outcomes = await processAgentAttachments(`topic:${topic.id}`, [src]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    if (outcomes[0].ok) {
      expect(outcomes[0].absolutePath).toContain(join("rooms", "roomA", "attachments")); // batch 7 P3 location
      expect(outcomes[0].absolutePath).not.toContain("topic:");
    }
  });
});
