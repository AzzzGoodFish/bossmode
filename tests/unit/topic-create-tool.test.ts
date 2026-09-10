import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/shared/config.js")>("../../src/shared/config.js");
  return {
    ...actual,
    getBossmodeDir: () => state.dir,
    ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
    getTopicSeedMode: () => "fork" as const,
    readConfig: () => ({ runtime: { topicSeedMode: "fork" }, defaults: {} }),
  };
});

import { handleToolCallback } from "../../src/engine/tools.js";
import { buildTopicGuideText, getTopic, readAllTopicMessages } from "../../src/workspace/topic-store.js";
import { readAllMessages } from "../../src/workspace/message-store.js";

function seedRoom(roomId: string, leaderId = "mem_pm") {
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["pm", "qa"],
    promptLeaderMemberId: leaderId,
    roomMembers: [
      { id: "mem_pm", name: "pm", sourceAgent: "pm", roomId, createdAt: 1, updatedAt: 1 },
      { id: "mem_qa", name: "qa", sourceAgent: "qa", roomId, createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
  };
  for (const member of room.roomMembers) {
    new MembersRepository(fixture.db).insert({ id: member.id, name: member.name, agentTemplate: member.sourceAgent,
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
  }
  new ConversationsRepository(fixture.db).upsertRoom({ ...room, globalMemberIds: room.roomMembers.map(m => m.id) });
}

describe("create_topic tool", () => {
  beforeEach(() => {
    fixture = coreFixture();
    state.dir = fixture.root;
  });
  afterEach(() => {
    fixture.close();
  });

  it("leader creates with brief before concurrency; title from first line", async () => {
    seedRoom("roomA");
    const result = await handleToolCallback("create_topic", "roomA", "pm", {
      message: "@qa please only research, do not merge",
      brief: "Research only — do not touch main",
    }, { memberId: "mem_pm" }) as any;
    expect(result.ok).toBe(true);
    expect(result.title).toBe("please only research, do not merge");
    expect(result.scopeId).toMatch(/^topic:/);
    const topic = getTopic("roomA", result.topicId)!;
    expect(topic.createdBy).toBe("pm");
    expect(topic.brief).toBe("Research only — do not touch main");
    expect(topic.guideText).toMatch(/Topic brief \(set by pm\): Research only — do not touch main/);
    const briefAt = topic.guideText!.indexOf("Topic brief");
    const concAt = topic.guideText!.indexOf("Concurrency:");
    expect(briefAt).toBeGreaterThan(-1);
    expect(concAt).toBeGreaterThan(briefAt);
    const tmsgs = readAllTopicMessages("roomA", topic.id);
    expect(tmsgs.some((m) => m.content.includes("@qa") && m.mentions.includes("qa"))).toBe(true);
    const roomMsgs = readAllMessages("roomA");
    const card = roomMsgs.find((m) => m.type === "topic_event");
    expect(card?.sender).toBe("pm");
  });

  it("allows non-leader to create a topic (leader gate retired)", async () => {
    seedRoom("roomB", "mem_pm");
    const result = await handleToolCallback("create_topic", "roomB", "qa", {
      message: "Non-leader topic",
    }, { memberId: "mem_qa" }) as any;
    expect(result.ok).toBe(true);
    expect(result.title).toBeTruthy();
  });

  it("omits brief section when brief is absent", () => {
    const g = buildTopicGuideText({
      title: "T",
      roomName: "dev",
      roomId: "r1",
      anchorExcerpt: "hello",
      seedMode: "fresh",
    });
    expect(g).not.toMatch(/Topic brief/);
    expect(g).toMatch(/Concurrency:/);
  });
});
