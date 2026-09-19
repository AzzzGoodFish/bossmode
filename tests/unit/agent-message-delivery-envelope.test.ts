import { loadMemberPromptSource, loadAgentMemberSnapshot } from "../../src/app/member-actions.js";
import { writeConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { MockRuntime, mockPromptFn, resetMocks } from "../helpers/mock-runtime.js";
import { RuntimeRegistry } from "../../src/agent/types.js";
import { activateAgent, initializeMemberRuntime } from "../../src/app/member-actions.js";
import { shutdownAll } from "../../src/agent/controls.js";
import { createMember } from "../../src/app/member-actions.js";
import { createRoom, stampGlobalMemberIds } from "../../src/chat/conversations.js";
import { importMessage } from "../../src/data/repositories/message-repository.js";


vi.mock("../../src/app/ws.js", () => ({
  broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn(),
}));

let fixture: ReturnType<typeof coreFixture>;
let memberId: string;
let roomId: string;

beforeEach(() => {
  fixture = coreFixture();
  writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
  resetMocks();
  memberId = createMember({ name: "pm", model: "test/model", credentialId: "fixture-credential" }).id;
  roomId = createRoom("bossmode dev", undefined, []).id;
  stampGlobalMemberIds(roomId, [memberId]);
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime("pi-cli"));
  initializeMemberRuntime(registry, loadMemberPromptSource, loadAgentMemberSnapshot);
});
afterEach(async () => {
  await shutdownAll();
  fixture.close();
});

describe("agent delivery envelope formatting", () => {
  it("hybrid: backlog compresses to one unread hint; trigger message injects in full", async () => {
    // Import exact historical sequence numbers, without adding live dispatch intents.
    for (const message of [
      { id: "m1", sender: "user", content: "first", mentions: [], ts: 1, seq: 101 },
      { id: "m2", sender: "architect", content: "second", mentions: [], ts: 2, seq: 102 },
      { id: "m3", sender: "user", content: "@pm status?", mentions: ["pm"], mentionMemberIds: [memberId], ts: 3, seq: 103 },
    ]) importMessage(fixture.db, roomId, message);

    await activateAgent(roomId, memberId);
    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    const sent = mockPromptFn.mock.calls[0][0] as string;
    expect(sent).toContain("you have 2 unread messages (No.101–No.102): user×1, architect×1");
    expect(sent).toContain("chat_read (from_seq 100)");
    expect(sent).toContain("No.103");
    expect(sent).toContain("@pm status?");
    expect(sent).not.toContain("first\n");
    expect(sent).not.toContain("second");
    expect(sent).not.toContain("mentioned by");
  });

  it("hybrid: no mention trigger → newest message is the trigger, earlier ones become the hint", async () => {
    for (const message of [
      { id: "m1", sender: "user", content: "plain msg", mentions: [], ts: 1, seq: 201 },
      { id: "m2", sender: "architect", content: "also plain", mentions: [], ts: 2, seq: 202 },
    ]) importMessage(fixture.db, roomId, message);

    await activateAgent(roomId, memberId);
    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    const sent = mockPromptFn.mock.calls[0][0] as string;
    expect(sent).toContain("you have 1 unread messages (No.201–No.201): user×1");
    expect(sent).toContain("No.202");
    expect(sent).toContain("also plain");
    expect(sent).not.toContain("plain msg");
    expect(sent).not.toContain("mentioned by");
  });
});
