import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { createTopic, addTopicMessage, readAllTopicMessages, resolveChatScopeRoomId } from "../../src/workspace/topic-store.js";
import { handleToolCallback } from "../../src/engine/tools.js";
import { processAgentAttachments } from "../../src/engine/agent-attachments.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const roomDir = join(state.dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  const room = {
    id: roomId,
    name: "R",
    cwd: tmpdir(),
    members: ["alice", "bob"],
    roomMembers: [
      { id: "rm_alice", name: "alice", sourceAgent: "pm", roomId, createdAt: 1, updatedAt: 1 },
      { id: "rm_bob", name: "bob", sourceAgent: "developer", roomId, createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
  } as Room;
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
  return room;
}

describe("topic chat scope: mentions / need_response / attachments", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-topic-chat-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("resolveChatScopeRoomId maps topic: to parent", () => {
    writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    expect(resolveChatScopeRoomId(`topic:${topic.id}`)).toBe("roomA");
    expect(resolveChatScopeRoomId("dm:mem_x")).toBeNull();
  });

  it("chat in topic: persists @ mentions and need_response from parent roster", async () => {
    writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    const scope = `topic:${topic.id}`;
    const result = await handleToolCallback("chat", scope, "alice", {
      message: "@bob please ack NR",
      need_response: ["bob"],
    });
    expect(result).toMatchObject({ ok: true });
    const msgs = readAllTopicMessages("roomA", topic.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].mentions).toContain("bob");
    expect(msgs[0].needResponse).toEqual(["bob"]);
  });

  it("attachments on topic: land in the parent room store", async () => {
    writeRoom("roomA");
    const topic = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    const src = join(tmpdir(), `topic-attach-${Date.now()}.txt`);
    writeFileSync(src, "hello-attach");
    const outcomes = await processAgentAttachments(`topic:${topic.id}`, [src]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    if (outcomes[0].ok) {
      expect(outcomes[0].absolutePath).toContain(".bossmode-attachments");
      expect(outcomes[0].absolutePath).not.toContain("topic:");
    }
  });
});
