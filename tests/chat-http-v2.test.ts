import { expect, it } from "vitest";
import { appendMessage } from "../src/chat/messages.js";
import { ensureMmScope } from "../src/chat/conversations.js";
import { createTestServer, jsonRequest, setupTestWorkspace } from "./helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const response = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  return JSON.parse(response.body).token;
}

it("reads room, DM and member chat facts through one conversation API", async () => {
  const test = await createTestServer();
  try {
    const token = await login(test.port);
    const createMember = async (name: string): Promise<string> => {
      const response = await jsonRequest(test.port, "POST", "/api/members", { token, body: { name } });
      expect(response.status).toBe(200);
      return JSON.parse(response.body).member.memberId;
    };
    const one = await createMember("http-one");
    const two = await createMember("http-two");
    const roomResponse = await jsonRequest(test.port, "POST", "/api/rooms", {
      token, body: { name: "HTTP room", memberIds: [one, two], leaderMemberId: one },
    });
    expect(roomResponse.status).toBe(200);
    const roomId = JSON.parse(roomResponse.body).id as string;
    const mm = ensureMmScope(one, two);
    const scopes = [`room:${roomId}`, `dm:${one}`, mm];
    scopes.forEach((scope, index) => appendMessage(scope, { sender: "user", content: `fact-${index}`, mentions: [] }));

    for (const [index, scope] of scopes.entries()) {
      const response = await jsonRequest(test.port, "GET", `/api/conversations/${encodeURIComponent(scope)}/messages`, { token });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ scopeId: scope, messages: [{ content: `fact-${index}` }] });
    }
    const chats = JSON.parse((await jsonRequest(test.port, "GET", "/api/chats", { token })).body).chats;
    expect(chats).toEqual(expect.arrayContaining([expect.objectContaining({ scopeId: mm, kind: "mm" })]));
    expect((await jsonRequest(test.port, "GET", `/api/rooms/${roomId}/messages`, { token })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => test.server.close(() => resolve()));
  }
});
