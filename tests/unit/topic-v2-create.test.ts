import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;

const state = vi.hoisted(() => ({ dir: "", seed: "fork" as "fork" | "fresh" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/shared/config.js")>("../../src/shared/config.js");
  return {
    ...actual,
    getBossmodeDir: () => state.dir,
    ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
    getTopicSeedMode: () => state.seed,
    readConfig: () => ({ runtime: { topicSeedMode: state.seed }, defaults: {} }),
  };
});

import { titleFromMessage, createTopic } from "../../src/workspace/topic-store.js";
import type { Room } from "../../src/shared/types.js";

function seedRoom(roomId: string): Room {
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["pm"],
    roomMembers: [{ id: "mem_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
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

describe("titleFromMessage", () => {
  it("strips leading mentions and takes the first line", () => {
    expect(titleFromMessage("@pm @qa please fix auth\nmore")).toBe("please fix auth");
    expect(titleFromMessage("")).toBe("");
  });
});

describe("createTopic seed default is fork", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
    state.seed = "fork";
  });
  afterEach(() => {
    fixture.close();
  });

  it("omitted seedMode writes fork", () => {
    seedRoom("roomA");
    const t = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1" });
    expect(t.seedMode).toBe("fork");
  });

  it("explicit fresh still wins on the store", () => {
    seedRoom("roomA");
    const t = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    expect(t.seedMode).toBe("fresh");
  });
});
