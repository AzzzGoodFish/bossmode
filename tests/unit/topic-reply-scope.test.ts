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

import { createTopic, addTopicMessage } from "../../src/workspace/topic-store.js";
import { loadScopeMessages, parseReplyToParam } from "../../src/engine/tools.js";
import { wrapRoomContextMessage } from "../../src/engine/message-envelope.js";
import type { Room } from "../../src/shared/types.js";

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
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
  return room;
}

describe("topic scope reply_to + envelope lookup", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-topic-reply-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("loadScopeMessages(topic:) returns topic jsonl, not the parent room", () => {
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
