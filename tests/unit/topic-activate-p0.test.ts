import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  getBossmodePiRuntimeRoot: () => join(state.dir, "pi-runtime"),
  readConfig: () => ({ runtime: {}, defaults: {} }),
  writeConfig: vi.fn(),
}));

import {
  createTopic,
  resolveOwningRoomId,
  agentEventsDirForScope,
} from "../../src/workspace/topic-store.js";
import { resolvePiAgentDir } from "../../src/engine/model-credentials.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const roomDir = join(state.dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["alice"],
    roomMembers: [{ id: "rm_alice", name: "alice", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
  } as Room;
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
  return room;
}

describe("topic scope owning room + event/agent dirs", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-topic-p0-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("resolveOwningRoomId maps topic: to parent room", () => {
    writeRoom("roomA");
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

  it("agent events for topic: live under rooms/<parent>/topics/<id>/, never rooms/topic:", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fork",
    });
    const dir = agentEventsDirForScope(`topic:${topic.id}`);
    expect(dir).toBe(join(state.dir, "rooms", "roomA", "topics", topic.id, "agent-events"));
    expect(dir.includes(`${join("rooms", "topic:")}`)).toBe(false);
    expect(agentEventsDirForScope("roomA")).toBe(join(state.dir, "rooms", "roomA", "agent-events"));
  });

  it("pi agentDir for topic: nests under parent room + topic- subdir", () => {
    writeRoom("roomA");
    const topic = createTopic({
      roomId: "roomA",
      title: "T",
      anchorMessageId: "m1",
      seedMode: "fork",
    });
    const dir = resolvePiAgentDir(`topic:${topic.id}`, "rm_alice");
    expect(dir.startsWith(join(state.dir, "pi-agent", "runtime", "roomA", "rm_alice", "topic-"))).toBe(true);
    expect(dir.includes("topic:")).toBe(false);
  });
});
