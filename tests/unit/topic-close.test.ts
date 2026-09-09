import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
let fixture: ReturnType<typeof conversationsFixture>;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
}));

import {
  createTopic,
  addTopicMessage,
  closeTopic,
  getTopic,
  summarizeTopicMessages,
} from "../../src/workspace/topic-store.js";
import { addMessage, readAllMessages, updateMessage } from "../../src/workspace/message-store.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
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
  fixture.repository().upsertRoom(room);
  return room;
}

describe("summarizeTopicMessages", () => {
  it("handles empty stream", () => {
    expect(summarizeTopicMessages([])).toMatch(/No discussion/i);
  });

  it("includes count and speaker lines", () => {
    const msgs = [
      { id: "1", sender: "user", content: "please fix auth", mentions: [], ts: 1 },
      { id: "2", sender: "developer", content: "looking now", mentions: [], ts: 2 },
    ] as RoomMessage[];
    const s = summarizeTopicMessages(msgs);
    expect(s).toMatch(/2 messages/);
    expect(s).toMatch(/you: please fix auth/);
    expect(s).toMatch(/developer: looking now/);
  });
});

describe("closeTopic + card flip", () => {
  beforeEach(() => {
    fixture = conversationsFixture();
    state.dir = fixture.root;
  });
  afterEach(() => {
    fixture.close();
  });

  it("closes, writes extractive summary, is idempotent", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "Auth flake",
      anchorMessageId: "m1",
      seedMode: "fresh",
    });
    addTopicMessage("roomA", topic.id, { sender: "user", content: "please fix auth", mentions: [] });
    addTopicMessage("roomA", topic.id, { sender: "developer", content: "patched the race", mentions: [] });

    const closed = closeTopic("roomA", topic.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.summary).toMatch(/2 messages/);
    expect(closed?.summary).toMatch(/patched the race/);
    expect(closed?.closedAt).toBeGreaterThan(0);

    const again = closeTopic("roomA", topic.id);
    expect(again?.closedAt).toBe(closed?.closedAt);
    expect(getTopic("roomA", topic.id)?.status).toBe("closed");
  });

  it("updateMessage flips opened topic_event to closed in place", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "Auth flake",
      anchorMessageId: "m1",
      seedMode: "fresh",
    });
    const opened = addMessage("roomA", {
      sender: "user",
      content: "Topic opened: Auth flake",
      mentions: [],
      type: "topic_event",
      topic_event_meta: { action: "opened", topicId: topic.id, title: "Auth flake", actor: "user" },
    });
    const closed = closeTopic("roomA", topic.id)!;
    const flipped = updateMessage("roomA", opened.id, {
      content: "Topic closed: Auth flake",
      type: "topic_event",
      topic_event_meta: {
        action: "closed",
        topicId: topic.id,
        title: "Auth flake",
        actor: "user",
        summary: closed.summary,
      },
    });
    expect(flipped?.id).toBe(opened.id);
    expect(flipped?.topic_event_meta?.action).toBe("closed");
    expect(flipped?.topic_event_meta?.summary).toBeTruthy();
    const all = readAllMessages("roomA");
    expect(all.filter((m) => m.type === "topic_event")).toHaveLength(1);
    expect(all[0].topic_event_meta?.action).toBe("closed");
  });
});
