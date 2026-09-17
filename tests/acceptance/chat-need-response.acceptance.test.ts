/** Chat surface and reply-debt silence (final-text fallback retired 2026-09-11). */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, jsonRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { mockPromptFn, resetMocks, setMockPromptFn, emitMockEvent } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: chat tool and reply-debt silence", () => {
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

  async function createRoomWithMembers(name: string, members: string[]) {
    return createMockRoom(ts.port, token, name, members);
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("waitFor timeout");
  }

  async function roomMessages(roomId: string) {
    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${roomId}/messages`, { token });
    return JSON.parse(res.body);
  }

  it("① user @ → member writes only bare text → room does NOT receive it; silence note fires (fallback retired)", async () => {
    const room = await createRoomWithMembers("ftd-user-bare", ["pm"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "bare text reply to the user", stopReason: "stop" });
    });

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm status?" } });

    await waitFor(async () => (await roomMessages(room.id)).some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying")));
    const messages = await roomMessages(room.id);
    // The bare text was never delivered.
    expect(messages.some((m: any) => m.sender === "pm")).toBe(false);
    expect(messages.some((m: any) => String(m.content).includes("bare text reply"))).toBe(false);
    // The user @ activation carried the REPLY EXPECTED banner.
    expect(prompts[0]).toContain("[REPLY EXPECTED] Respond using the chat tool.");
    // The silence is made visible.
    expect(messages.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"))).toBe(true);
  });

  it("② captured member reply debt keeps the sender banner; bare text is not delivered and the note fires", async () => {
    const room = await createRoomWithMembers("ftd-need-response", ["pm", "qa"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "qa bare reply under expectation", stopReason: "stop" });
    });

    const { postMessage } = await import("../../src/chat/message-bus.js");
    postMessage(room.id, "pm", "@qa verify the fallback", ["qa"], { senderMemberId: room.globalMemberIds![0], mentionMemberIds: [room.globalMemberIds![1]], needResponse: ["qa"], needResponseMemberIds: [room.globalMemberIds![1]] });

    await waitFor(async () => (await roomMessages(room.id)).some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying")));
    const messages = await roomMessages(room.id);
    // pm's chat message carries needResponse.
    const pmMsg = messages.find((m: any) => m.sender === "pm");
    expect(pmMsg.needResponse).toEqual(["qa"]);
    // qa's activation payload has the sender-named banner.
    expect(prompts.some((p) => p.includes("[REPLY EXPECTED] pm expects your reply — respond with the chat tool."))).toBe(true);
    // qa never called chat → bare text is not delivered; only the silence note appears.
    expect(messages.some((m: any) => m.sender === "qa")).toBe(false);
    expect(messages.some((m: any) => String(m.content).includes("qa bare reply"))).toBe(false);
  });

  it("③ member chat activates FYI: no banner, no fallback, no warning", async () => {
    const room = await createRoomWithMembers("ftd-fyi", ["pm", "qa"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "qa work note (invisible)", stopReason: "stop" });
    });

    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const res = await handleToolCallback("chat_send", room.id, "pm", { message: "@qa heads up" });
    expect((res as any).ok).toBe(true);

    await waitFor(() => prompts.length >= 1);
    // Activated (FYI) but no REPLY EXPECTED banner.
    expect(prompts.some((p) => p.includes("[REPLY EXPECTED]"))).toBe(false);
    // No debt → bare text not delivered, no silence warning.
    const messages = await roomMessages(room.id);
    expect(messages.some((m: any) => m.sender === "qa")).toBe(false);
    expect(messages.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"))).toBe(false);
  });

  it("④ chat_send exposes only to/message/attachments and rejects unknown parameters before posting", async () => {
    const room = await createRoomWithMembers("ftd-chat-tool", ["pm"]);
    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const { createBossmodeSdkTools } = await import("../../src/agent/runtime/tools.js");

    // SDK tool surface exposes only current supported arguments.
    const chatTool = createBossmodeSdkTools({ memberId: "mem_schema_fixture", roomId: room.id })[0];
    expect(chatTool.name).toBe("chat_send");
    expect(Object.keys((chatTool.parameters as any).properties)).toEqual(["to", "message", "attachments"]);
    expect((chatTool.parameters as any).additionalProperties).toBe(false);
    // artifacts param removed from chat tool.
    expect(JSON.stringify(chatTool.parameters)).not.toContain("artifacts");

    // Obsolete arguments are rejected, not silently honored or ignored.
    const noTarget = await handleToolCallback("chat_send", room.id, "pm", { message: "plain post", need_response: ["qa"] });
    expect(noTarget).toEqual({ ok: false, error: "Unknown chat_send parameter: need_response" });
    expect(await roomMessages(room.id)).toEqual([]);
    expect(await handleToolCallback("chat_send", room.id, "pm", { message: "plain post" })).toMatchObject({ ok: true });
  });

  it("⑤ DM same rule: user DM message expects a reply → bare text is not delivered; silence note lands in the DM", async () => {
    const memberRes = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "architect", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    const memberId = JSON.parse(memberRes.body).member.memberId;

    setMockPromptFn(async () => {
      emitMockEvent({ type: "message_end", text: "dm bare reply", stopReason: "stop" });
    });

    await jsonRequest(ts.port, "POST", `/api/dm/${memberId}/messages`, { token, body: { text: "hello in private" } });

    await waitFor(async () => {
      const res = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages`, { token });
      const msgs = JSON.parse(res.body).messages;
      return msgs.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"));
    });
    const dmRes = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages`, { token });
    const dmMessages = JSON.parse(dmRes.body).messages;
    expect(dmMessages.some((m: any) => m.content === "dm bare reply")).toBe(false);
    expect(dmMessages.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"))).toBe(true);
  });
});
