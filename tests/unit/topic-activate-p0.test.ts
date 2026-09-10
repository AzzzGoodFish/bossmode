import { appendEventToDisk, loadEventsFromDisk } from "../../src/engine/event-handler.js";
import { broadcastToAgentSubscribers } from "../../src/communication/ws.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;

vi.mock("../../src/communication/ws.js", () => ({ broadcastToAgentSubscribers: vi.fn() }));

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
  getBossmodePiRuntimeRoot: () => join(state.dir, "pi-runtime"),
  readConfig: () => ({ runtime: {}, defaults: {} }),
  writeConfig: vi.fn(),
}));

import {
  createTopic,
  resolveOwningRoomId,
} from "../../src/workspace/topic-store.js";
import { resolvePiAgentDir } from "../../src/engine/model-credentials.js";
import type { Room } from "../../src/shared/types.js";

function seedRoom(roomId: string): Room {
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["alice"],
    roomMembers: [{ id: "mem_alice", name: "alice", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
  } as Room;
  for (const member of room.roomMembers ?? []) {
    new MembersRepository(fixture.db).insert({ id: member.id, name: member.name, agentTemplate: member.sourceAgent,
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
  }
  room.globalMemberIds = room.roomMembers!.map(m => m.id);
  new ConversationsRepository(fixture.db).upsertRoom(room);
  return room;
}

describe("topic scope owning room + event/agent dirs", () => {
  beforeEach(() => {
    vi.mocked(broadcastToAgentSubscribers).mockClear();
    fixture = coreFixture();
    state.dir = fixture.root;
  });
  afterEach(async () => {
    await Promise.resolve();
    fixture.close();
  });

  it("resolveOwningRoomId maps topic: to parent room", () => {
    seedRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fork",
    });
    expect(resolveOwningRoomId(`topic:${topic.id}`)).toBe("roomA");
    expect(resolveOwningRoomId("roomA")).toBe("roomA");
    expect(resolveOwningRoomId("room:roomA")).toBe("roomA");
    expect(resolveOwningRoomId("dm:mem_x")).toBe("dm:mem_x");
  });

  it("agent events persist under the topic SQL scope, without parent leakage or phantom directories", async () => {
    seedRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fork",
    });
    const scopeId = `topic:${topic.id}`;
    const event = { type: "agent_start" as const, ts: 123 };
    appendEventToDisk(scopeId, "mem_alice", event);
    expect(loadEventsFromDisk(scopeId, "mem_alice")).toEqual([event]);
    expect(loadEventsFromDisk("roomA", "mem_alice")).toEqual([]);
    expect(fixture.db.get("SELECT room_id FROM scopes WHERE id=?", scopeId)).toEqual({ room_id: "roomA" });
    expect(existsSync(join(state.dir, "rooms", scopeId))).toBe(false);
    expect(existsSync(join(state.dir, "rooms", "roomA", "topics", topic.id, "agent-events"))).toBe(false);
    await vi.waitFor(() => expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(scopeId, "mem_alice", expect.objectContaining({ event })));
  });

  it("pi agentDir for topic: nests under parent room + topic- subdir", () => {
    seedRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fork",
    });
    const dir = resolvePiAgentDir(`topic:${topic.id}`, "mem_alice");
    expect(dir.startsWith(join(state.dir, "pi-agent", "runtime", "roomA", "mem_alice", "topic-"))).toBe(true);
    expect(dir.includes("topic:")).toBe(false);
  });
});
