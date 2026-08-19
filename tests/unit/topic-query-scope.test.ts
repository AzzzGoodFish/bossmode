import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function seedAgent(name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`, "utf-8");
}

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
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-topic-query-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    seedAgent("dev");
    seedAgent("outsider");
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    const reg = await import("../../src/workspace/member-registry.js");
    const creds = await import("../../src/engine/model-credentials.js");
    const cred = creds.saveModelCredentialProfile(PROFILE);
    const dev = reg.createMember({ name: "dev", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
    const outsider = reg.createMember({ name: "outsider", agentTemplate: "outsider", model: "testprov/claude-a", credentialId: cred.id });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("alpha", dir, [{ agent: "dev", name: "dev" }], undefined);
    roomStore.stampGlobalMemberIds(room.id, [dev.id], dev.id);
    const other = roomStore.createRoom("gamma", dir, [{ agent: "outsider", name: "outsider" }], undefined);
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
    const { topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const scope = `topic:${topic.id}`;

    const all = (await tools.handleToolCallback("query_room_messages", scope, "dev", {})) as any[];
    expect(all.map((m) => m.content)).toEqual(["topic hello", "topic ack"]);
    expect(all.every((m) => m.content !== "room only history")).toBe(true);

    const after = (await tools.handleToolCallback("query_room_messages", scope, "dev", { from_seq: 1 })) as any[];
    expect(after.map((m) => m.content)).toEqual(["topic ack"]);

    const q = (await tools.handleToolCallback("query_room_messages", scope, "dev", { query: "hello" })) as any[];
    expect(q.map((m) => m.content)).toEqual(["topic hello"]);
  });

  it("room instance explicit scope reads the topic, not the parent room", async () => {
    const { room, topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const res = (await tools.handleToolCallback("query_room_messages", room.id, "dev", {
      scope: `topic:${topic.id}`,
    })) as any[];
    expect(res.map((m) => m.content)).toEqual(["topic hello", "topic ack"]);
    expect(res.some((m) => m.content === "room only history")).toBe(false);
  });

  it("outsider cannot read a topic in a room they are not in", async () => {
    const { other, topic } = await seed();
    const tools = await import("../../src/engine/tools.js");
    const denied = (await tools.handleToolCallback("query_room_messages", other.id, "outsider", {
      scope: `topic:${topic.id}`,
    })) as any;
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toMatch(/Access denied|not a member/i);
  });
});
