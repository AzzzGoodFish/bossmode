/**
 * 注入混合制 acceptance — 两轮激活链路:
 * 激活带背 log 提示 → member 用 chat_read 读到即清 → 下轮激活提示消失。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { mockPromptFn, resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: inject hybrid (two-activation chain)", () => {
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

  it("hint on first activation → read-to-clear → no hint on second activation", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    expect(created.status, created.body).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId;
    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "hybrid-room", memberIds: [memberId], leaderMemberId: memberId },
    });
    expect(roomRes.status, roomRes.body).toBe(200);
    const room = JSON.parse(roomRes.body);

    // Two backlog messages, then an @pm trigger (each POST activates pm)
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => { prompts.push(msg); });

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "backlog one" } });
    // No @ → pm not activated by this message; second backlog
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "backlog two" } });
    // Now the trigger
    const trig = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm status?" } });
    const triggerMsg = JSON.parse(trig.body);

    // Activation is async — poll until the prompt arrives
    const waitForPrompt = async (n: number) => {
      for (let i = 0; i < 40; i++) {
        if (prompts.length >= n) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    await waitForPrompt(1);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("you have 2 unread messages");
    expect(prompts[0]).toContain("from_seq");
    expect(prompts[0]).toContain("@pm status?");

    // Read-to-clear: member queries the backlog (as its tool would)
    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const res = await handleToolCallback("chat_read", room.id, "pm", { from_seq: 0, limit: 50 });
    expect(Array.isArray(res)).toBe(true);
    const roomStore = await import("../../src/chat/conversations.js");
    const cursors = roomStore.getCursors(room.id);
    const pmMemberId = (await import("../../src/member/identity.js")).findMemberByName("pm")!.id;
    expect(cursors[pmMemberId]).toBe(triggerMsg.id); // cursor advanced past the trigger

    // Second activation: new @pm message, no backlog → NO hint
    prompts.length = 0;
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm again?" } });
    await waitForPrompt(1);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("unread messages");
    expect(prompts[0]).toContain("@pm again?");

    // Third activation with a self-reply in between: pm replies, then fish
    // asks again — the self reply must NOT count as unread (QA打回, fish 14843).
    const { postMessage } = await import("../../src/chat/message-bus.js");
    postMessage(room.id, "pm", "PONG SELF", [], { senderMemberId: pmMemberId });
    prompts.length = 0;
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm third?" } });
    await waitForPrompt(1);
    const third = prompts[prompts.length - 1];
    expect(third).toContain("@pm third?");
    expect(third).not.toContain("unread messages"); // own reply excluded
    expect(third).not.toContain("PONG SELF");

    // Round 4 — the phantom-unread regression (QA 2026-08-06): the cursor must
    // land ON the trigger (closed interval), never regress below it via the
    // self-skip. The previous trigger must not re-appear as unread.
    prompts.length = 0;
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm fourth?" } });
    await waitForPrompt(1);
    const fourth = prompts[prompts.length - 1];
    expect(fourth).toContain("@pm fourth?");
    expect(fourth).not.toContain("unread messages"); // no phantom previous trigger
    expect(fourth).not.toContain("@pm third?");
  });
});
