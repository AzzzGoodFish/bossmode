/**
 * chat 工具回归 + need_response + 最终文本兜底 acceptance（fish 2026-08-07 定稿）:
 * ① user @ → member 只写裸文本 → 房间仍收到（兜底必达 — 失声事故直接回归）
 * ② member need_response=true → 目标信封带 [REPLY EXPECTED] + 无 chat 时兜底
 * ③ need_response 缺省 @ → 目标激活但无债无兜底无警告（FYI 通道）
 * ④ chat 工具全参可用（attachments/artifacts 恢复）
 * ⑤ DM 同规则：用户消息带期待，裸文本兜底投递
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { mockPromptFn, resetMocks, setMockPromptFn, emitMockEvent } from "../helpers/mock-runtime.js";



vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name, model: "mock-model", description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`, skills: [], tags: [],
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "mock-model", description: "PM agent", skills: [], tags: [] },
    { name: "qa", model: "mock-model", description: "QA agent", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

describe("Acceptance: chat tool + need_response + final-text fallback", () => {
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
    for (const m of members) {
      await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: m, agentTemplate: m, model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    }
    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, cwd: "/tmp", members: members.map((m) => ({ agent: m, name: m })), promptLeaderMemberName: members[0] },
    });
    return JSON.parse(roomRes.body);
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("waitFor timeout");
  }

  async function roomMessages(roomId: string) {
    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${roomId}/messages`, { token });
    return JSON.parse(res.body);
  }

  it("① user @ → member writes only bare text → room still receives it (autoDelivered fallback)", async () => {
    const room = await createRoomWithMembers("ftd-user-bare", ["pm"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "bare text reply to the user", stopReason: "stop" });
    });

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm status?" } });

    await waitFor(async () => (await roomMessages(room.id)).some((m: any) => m.sender === "pm"));
    const messages = await roomMessages(room.id);
    const pmMsg = messages.find((m: any) => m.sender === "pm");
    expect(pmMsg.content).toBe("bare text reply to the user");
    expect(pmMsg.autoDelivered).toBe(true);
    // The user @ activation carried the REPLY EXPECTED banner.
    expect(prompts[0]).toContain("[REPLY EXPECTED] Respond using the chat tool.");
    // No silence note — the fallback delivered.
    expect(messages.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"))).toBe(false);
  });

  it("② member chat need_response=true → target envelope has [REPLY EXPECTED] + bare-text fallback on target", async () => {
    const room = await createRoomWithMembers("ftd-need-response", ["pm", "qa"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "qa bare reply under expectation", stopReason: "stop" });
    });

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const res = await handleToolCallback("chat", room.id, "pm", { message: "@qa verify the fallback", need_response: ["qa"] });
    expect((res as any).ok).toBe(true);

    await waitFor(async () => (await roomMessages(room.id)).some((m: any) => m.sender === "qa"));
    const messages = await roomMessages(room.id);
    // pm's chat message carries needResponse.
    const pmMsg = messages.find((m: any) => m.sender === "pm");
    expect(pmMsg.needResponse).toEqual(["qa"]);
    // qa's activation payload has the sender-named banner.
    expect(prompts.some((p) => p.includes("[REPLY EXPECTED] pm expects your reply — respond with the chat tool."))).toBe(true);
    // qa never called chat → bare text fallback-posted.
    const qaMsg = messages.find((m: any) => m.sender === "qa");
    expect(qaMsg.content).toBe("qa bare reply under expectation");
    expect(qaMsg.autoDelivered).toBe(true);
  });

  it("③ member chat without need_response → target activates FYI: no banner, no fallback, no warning", async () => {
    const room = await createRoomWithMembers("ftd-fyi", ["pm", "qa"]);
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => {
      prompts.push(msg);
      emitMockEvent({ type: "message_end", text: "qa work note (invisible)", stopReason: "stop" });
    });

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const res = await handleToolCallback("chat", room.id, "pm", { message: "@qa heads up" });
    expect((res as any).ok).toBe(true);

    await waitFor(() => prompts.length >= 1);
    // Activated (FYI) but no REPLY EXPECTED banner.
    expect(prompts.some((p) => p.includes("[REPLY EXPECTED]"))).toBe(false);
    // No debt → bare text not delivered, no silence warning.
    const messages = await roomMessages(room.id);
    expect(messages.some((m: any) => m.sender === "qa")).toBe(false);
    expect(messages.some((m: any) => m.sender === "system" && String(m.content).includes("finished without replying"))).toBe(false);
  });

  it("④ chat tool is back with attachments; need_response with no @target is ignored with a note", async () => {
    const room = await createRoomWithMembers("ftd-chat-tool", ["pm"]);
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");

    // SDK tool surface exposes chat (first tool) with need_response param.
    const chatTool = createBossmodeSdkTools({ roomId: room.id, agentName: "pm", roomMembers: ["pm"] })[0];
    expect(chatTool.name).toBe("chat");
    expect(JSON.stringify(chatTool.parameters)).toContain("need_response");
    // artifacts param removed from chat tool.
    expect(JSON.stringify(chatTool.parameters)).not.toContain("artifacts");

    // need_response without @target → posted normally, note attached.
    const noTarget = await handleToolCallback("chat", room.id, "pm", { message: "plain post", need_response: ["qa"] });
    expect((noTarget as any).ok).toBe(true);
    expect((noTarget as any).note).toContain("no @target");
  });

  it("⑤ DM same rule: user DM message expects a reply → bare text fallback-delivered into the DM", async () => {
    const memberRes = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "architect", agentTemplate: "architect", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    const memberId = JSON.parse(memberRes.body).member.memberId;

    setMockPromptFn(async () => {
      emitMockEvent({ type: "message_end", text: "dm bare reply", stopReason: "stop" });
    });

    await jsonRequest(ts.port, "POST", `/api/dm/${memberId}/messages`, { token, body: { text: "hello in private" } });

    const dmRes = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages`, { token });
    const dmMessages = JSON.parse(dmRes.body).messages;
    const memberMsg = dmMessages.find((m: any) => m.sender !== "user" && m.sender !== "system");
    expect(memberMsg).toBeTruthy();
    expect(memberMsg.content).toBe("dm bare reply");
    expect(memberMsg.autoDelivered).toBe(true);
  });
});
