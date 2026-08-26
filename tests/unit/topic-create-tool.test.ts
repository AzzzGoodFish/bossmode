import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function writeRoom(roomId: string, leaderId = "rm_pm") {
  const roomDir = join(state.dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(join(roomDir, "room.json"), JSON.stringify({
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["pm", "qa"],
    promptLeaderMemberId: leaderId,
    roomMembers: [
      { id: "rm_pm", name: "pm", sourceAgent: "pm", roomId, createdAt: 1, updatedAt: 1 },
      { id: "rm_qa", name: "qa", sourceAgent: "qa", roomId, createdAt: 1, updatedAt: 1 },
    ],
    createdAt: 1,
  }), "utf-8");
}

describe("create_topic tool", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-create-topic-"));
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("leader creates with brief before concurrency; title from first line", async () => {
    writeRoom("roomA");
    const result = await handleToolCallback("create_topic", "roomA", "pm", {
      message: "@qa please only research, do not merge",
      brief: "Research only — do not touch main",
    }) as any;
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
    writeRoom("roomB", "rm_pm");
    const result = await handleToolCallback("create_topic", "roomB", "qa", {
      message: "Non-leader topic",
    }) as any;
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
