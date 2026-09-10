import type { coreFixture } from "../helpers/core-fixture.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;
let dir = "";

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return { ...actual, broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn() };
});

const PROFILE = {
  name: "Test provider",
  providerSlug: "testprov",
  protocol: "openai-responses" as const,
  baseUrl: "https://example.invalid/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [{ id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] }],
};

describe("query_room_messages topic scope", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
  });
  afterEach(() => {
    fixture.close();
  });

  async function seed() {
    const reg = await import("../../src/workspace/member-registry.js");
    const creds = await import("../../src/engine/model-credentials.js");
    const cred = creds.saveModelCredentialProfile(PROFILE);
    const dev = reg.createMember({ name: "dev", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
    const outsider = reg.createMember({ name: "outsider", agentTemplate: "outsider", model: "testprov/claude-a", credentialId: cred.id });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("alpha", undefined, []);
    roomStore.stampGlobalMemberIds(room.id, [dev.id], dev.id);
    const other = roomStore.createRoom("gamma", undefined, []);
    roomStore.stampGlobalMemberIds(other.id, [outsider.id], outsider.id);
    const topicStore = await import("../../src/workspace/topic-store.js");
    const topic = topicStore.createTopic({ roomId: room.id, title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    topicStore.addTopicMessage(room.id, topic.id, { sender: "user", content: "topic hello", mentions: [] });
    topicStore.addTopicMessage(room.id, topic.id, { sender: "dev", content: "topic ack", mentions: [] });
    const messageStore = await import("../../src/workspace/message-store.js");
    messageStore.addMessage(room.id, { sender: "user", content: "room only history", mentions: [] });
    return { dev, outsider, room, other, topic };
  }

  it("topic instance reads its own history (no filter / from_seq / query)", async () => {
    const { dev, topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const scope = `topic:${topic.id}`;

    const all = (await tools.handleToolCallback("query_room_messages", scope, "dev", {}, { memberId: dev.id })) as any[];
    expect(all.map((m) => m.content)).toEqual(["topic hello", "topic ack"]);
    expect(all.every((m) => m.content !== "room only history")).toBe(true);

    const after = (await tools.handleToolCallback("query_room_messages", scope, "dev", { from_seq: 1 }, { memberId: dev.id })) as any[];
    expect(after.map((m) => m.content)).toEqual(["topic ack"]);

    const q = (await tools.handleToolCallback("query_room_messages", scope, "dev", { query: "hello" }, { memberId: dev.id })) as any[];
    expect(q.map((m) => m.content)).toEqual(["topic hello"]);
  });

  it("room instance explicit scope reads the topic, not the parent room", async () => {
    const { dev, room, topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const res = (await tools.handleToolCallback("query_room_messages", room.id, "dev", {
      scope: `topic:${topic.id}`,
    }, { memberId: dev.id })) as any[];
    expect(res.map((m) => m.content)).toEqual(["topic hello", "topic ack"]);
    expect(res.some((m) => m.content === "room only history")).toBe(false);
  });

  it("outsider cannot read a topic in a room they are not in", async () => {
    const { outsider, other, topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const denied = (await tools.handleToolCallback("query_room_messages", other.id, "outsider", {
      scope: `topic:${topic.id}`,
    }, { memberId: outsider.id })) as any;
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toMatch(/Access denied|not a member/i);
  });
});
