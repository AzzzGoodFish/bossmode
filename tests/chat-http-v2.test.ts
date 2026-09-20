import { expect, it } from "vitest";
import { ensureMmScope } from "../src/chat/conversations.js";
import { updateMember } from "../src/member/identity.js";
import { createTestServer, jsonRequest, setupTestWorkspace } from "./helpers/test-server.js";
import { request } from "node:http";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const response = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  return JSON.parse(response.body).token;
}
function rawRequest(port: number, method: string, path: string, token: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

it("manages room membership and settings with stable member IDs", async () => {
  const test = await createTestServer();
  try {
    const token = await login(test.port);
    const createMember = async (name: string): Promise<string> => {
      const response = await jsonRequest(test.port, "POST", "/api/members", { token, body: { name } });
      expect(response.status).toBe(200);
      return JSON.parse(response.body).member.memberId;
    };
    const leader = await createMember("room-leader");
    const invited = await createMember("room-invited");
    const created = await jsonRequest(test.port, "POST", "/api/rooms", {
      token, body: { name: "Initial", memberIds: [leader], leaderMemberId: leader },
    });
    expect(created.status).toBe(200);
    const roomId = JSON.parse(created.body).id as string;
    updateMember(leader, { title: "Lead", global: { model: "test:model", credentialId: "profile-test", thinkingLevel: "high" } });
    const roster = await jsonRequest(test.port, "GET", `/api/rooms/${roomId}/members`, { token });
    expect(JSON.parse(roster.body)).toEqual([expect.objectContaining({
      id: leader, name: "room-leader", title: "Lead", agentTemplate: "general",
      model: "test:model", credentialId: "profile-test", thinkingLevel: "high",
    })]);

    const patched = await jsonRequest(test.port, "PATCH", `/api/rooms/${roomId}`, {
      token, body: { name: "Renamed", description: "Canonical room", docsPath: "project/docs" },
    });
    expect(JSON.parse(patched.body)).toMatchObject({
      id: roomId, name: "Renamed", description: "Canonical room", docsPath: "project/docs/", memberIds: [leader],
    });
    const added = await jsonRequest(test.port, "POST", `/api/rooms/${roomId}/members`, {
      token, body: { memberId: invited },
    });
    expect(JSON.parse(added.body).memberIds).toEqual([leader, invited]);
    const removed = await jsonRequest(test.port, "DELETE", `/api/rooms/${roomId}/members/${invited}`, { token });
    expect(JSON.parse(removed.body).memberIds).toEqual([leader]);
    expect((await jsonRequest(test.port, "DELETE", `/api/rooms/${roomId}`, { token })).status).toBe(200);
    expect((await jsonRequest(test.port, "GET", `/api/rooms/${roomId}`, { token })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => test.server.close(() => resolve()));
  }
});

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
    for (const [index, scope] of scopes.entries()) {
      const written = await jsonRequest(test.port, "POST", `/api/conversations/${encodeURIComponent(scope)}/messages`, {
        token, body: { content: `fact-${index}` },
      });
      expect(written.status).toBe(200);
    }

    for (const [index, scope] of scopes.entries()) {
      const response = await jsonRequest(test.port, "GET", `/api/conversations/${encodeURIComponent(scope)}/messages`, { token });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.scopeId).toBe(scope);
      expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: `fact-${index}` })]));
      const uploaded = await rawRequest(test.port, "POST",
        `/api/conversations/${encodeURIComponent(scope)}/attachments?filename=fact-${index}.txt`, token, Buffer.from(`file-${index}`));
      expect(uploaded.status).toBe(200);
      const url = JSON.parse(uploaded.body.toString()).url as string;
      const downloaded = await rawRequest(test.port, "GET", url, token);
      expect(downloaded).toMatchObject({ status: 200, body: Buffer.from(`file-${index}`) });
    }
    const chats = JSON.parse((await jsonRequest(test.port, "GET", "/api/chats", { token })).body).chats;
    expect(chats).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: `room:${roomId}`, kind: "room" }),
      expect.objectContaining({ scopeId: `dm:${one}`, kind: "dm" }),
    ]));
    expect(chats.some((chat: { kind: string }) => chat.kind === "mm")).toBe(false);
    const memberScopes = JSON.parse((await jsonRequest(test.port, "GET", `/api/members/${one}/scopes`, { token })).body).scopes;
    expect(memberScopes.some((scope: { kind: string }) => scope.kind === "mm")).toBe(false);
    const read = await jsonRequest(test.port, "POST", `/api/conversations/${encodeURIComponent(`room:${roomId}`)}/read`, { token, body: {} });
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).cursor).toMatchObject({ seq: 1 });
    expect((await jsonRequest(test.port, "GET", `/api/rooms/${roomId}/messages`, { token })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => test.server.close(() => resolve()));
  }
});
