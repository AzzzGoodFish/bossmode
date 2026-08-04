/**
 * Acceptance: Urgent `!name` interrupt sequence (fish 2026-08-04).
 *
 * - working target → abort primitive fires, system notice lands, and the urgent
 *   message becomes the NEXT turn carrying the [INTERRUPTED] banner (never a steer)
 * - persisted message snapshots ! targets into mentions + urgentMentions
 * - idle target → straight-through activation, no abort, no banner
 * - "Hello!pm" plain text never fires
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Room } from "../../src/shared/types.js";
import {
  setupConfigMock,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  configureMockMembersForRoom,
} from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";

import { resetMocks, setMockPromptFn, mockAbortFn, mockSteerFn } from "../helpers/mock-runtime.js";

setupConfigMock();

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn().mockImplementation((name: string) => ({
    id: name, name, type: "agent", agent: name,
    model: "mock-model", runtime: "mock", skills: [], thinkingLevel: "off",
  })),
  loadMembers: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name, model: "mock-model", description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`, skills: [], tags: [],
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "mock-model", description: "PM", skills: [], tags: [] },
    { name: "qa", model: "mock-model", description: "QA", skills: [], tags: [] },
  ]),
}));

describe("Acceptance: urgent ! interrupt", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  async function createRoom(name: string, members: string[]): Promise<Room> {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, cwd: "/tmp", members: members.map((member) => ({ agent: member, name: member })), promptLeaderMemberName: members[0] },
    });
    expect(res.status).toBe(200);
    const room = JSON.parse(res.body);
    await configureMockMembersForRoom(room.id, members);
    return room;
  }

  async function sendMessage(roomId: string, content: string) {
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, { token, body: { content } });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  async function getMessages(roomId: string): Promise<any[]> {
    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${roomId}/messages?limit=100`, { token });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    return data.messages ?? data;
  }

  it("working target: abort fires, notice lands, urgent message becomes next turn with banner", async () => {
    const room = await createRoom("urgent-working", ["pm"]);

    const promptCalls: string[] = [];
    let promptResolveFn: (() => void) | undefined;
    setMockPromptFn(async (msg: string) => {
      promptCalls.push(msg);
      await new Promise<void>((resolve) => { promptResolveFn = resolve; });
    });

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    // 1) pm starts working on a long task
    await sendMessage(room.id, "@pm long task");
    await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
      3000,
    );
    expect(promptCalls).toHaveLength(1);

    // 2) urgent gesture — abort the running turn, no steer
    await sendMessage(room.id, "!pm drop everything and reply");
    // The interrupt notice may post synchronously before the route re-reads the
    // latest message — assert on OUR message from the store, not the response.
    const posted = await vi.waitFor(async () => {
      const msgs = await getMessages(room.id);
      const mine = msgs.find((m) => typeof m.content === "string" && m.content.includes("drop everything"));
      expect(mine).toBeTruthy();
      return mine;
    }, { timeout: 3000 });
    expect(posted.mentions).toContain("pm");
    expect(posted.urgentMentions).toEqual(["pm"]);
    expect(posted.urgentMentionMemberIds?.length).toBe(1);

    await vi.waitFor(() => expect(mockAbortFn).toHaveBeenCalled(), { timeout: 3000 });
    // The urgent payload must NOT be steered into the dying turn
    for (const call of mockSteerFn.mock.calls) {
      expect(String(call[0])).not.toContain("drop everything");
    }

    // 3) system notice records the interrupt (user-visible)
    await vi.waitFor(async () => {
      const msgs = await getMessages(room.id);
      expect(msgs.some((m) => m.sender === "system" && /aborted by an urgent message/.test(m.content))).toBe(true);
    }, { timeout: 3000 });

    // 4) aborted turn settles → urgent message runs as the next turn, with banner
    promptResolveFn!();
    await vi.waitFor(() => expect(promptCalls.length).toBe(2), { timeout: 3000 });
    expect(promptCalls[1]).toContain("[INTERRUPTED]");
    expect(promptCalls[1]).toContain("drop everything and reply");

    await wsClient.close();
  });

  it("idle target: straight-through activation, no abort, no banner; plain-text ! never fires", async () => {
    const room = await createRoom("urgent-idle", ["pm"]);

    const promptCalls: string[] = [];
    setMockPromptFn(async (msg: string) => {
      promptCalls.push(msg);
    });

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    // plain-text ! glued to a word — no activation at all
    await sendMessage(room.id, "Hello!pm how are you");
    await new Promise((r) => setTimeout(r, 400));
    expect(promptCalls).toHaveLength(0);
    expect(mockAbortFn).not.toHaveBeenCalled();

    // backticked !pm — code is literal text: no activation, no urgent snapshot
    await sendMessage(room.id, "对照 `!pm` 应字面渲染不触发");
    await new Promise((r) => setTimeout(r, 400));
    expect(promptCalls).toHaveLength(0);
    expect(mockAbortFn).not.toHaveBeenCalled();
    const msgs = await getMessages(room.id);
    const codeMsg = msgs.find((m) => typeof m.content === "string" && m.content.includes("应字面渲染"));
    expect(codeMsg).toBeTruthy();
    expect(codeMsg.urgentMentions ?? []).toEqual([]);
    expect(codeMsg.mentions ?? []).toEqual([]);

    // idle urgent — direct activation without abort or banner
    await sendMessage(room.id, "!pm quick question");
    await vi.waitFor(() => expect(promptCalls.length).toBe(1), { timeout: 3000 });
    expect(mockAbortFn).not.toHaveBeenCalled();
    expect(promptCalls[0]).toContain("quick question");
    expect(promptCalls[0]).not.toContain("[INTERRUPTED]");

    await wsClient.close();
  });
});
