import { expect, it } from "vitest";
import {
  closeTestServer,
  createTestServer,
  jsonRequest,
  setupTestWorkspace,
} from "./helpers/test-server.js";

setupTestWorkspace();

it("validates the three canonical room write bodies before mutating", async () => {
  const test = await createTestServer();
  try {
    const login = await jsonRequest(test.port, "POST", "/api/auth/login", {
      body: { username: "testuser", password: "testpass" },
    });
    const token = JSON.parse(login.body).token as string;
    const request = (method: string, path: string, body?: unknown) =>
      jsonRequest(test.port, method, path, { token, body });
    const createMember = async (name: string): Promise<string> => {
      const response = await request("POST", "/api/members", { name });
      expect(response.status, response.body).toBe(200);
      return JSON.parse(response.body).member.memberId;
    };
    const leader = await createMember("strict-room-leader");
    const peer = await createMember("strict-room-peer");
    const outsider = await createMember("strict-room-outsider");
    const missing = "mem_aaaaaaaaaa";

    const roomsBefore = JSON.parse((await request("GET", "/api/rooms")).body);
    for (const body of [
      ["not-an-object"],
      { name: "Unknown field", memberIds: [leader], members: [] },
      { memberIds: [leader] },
      { name: "Wrong members", memberIds: leader },
      { name: "Malformed member", memberIds: ["strict-room-leader"] },
      { name: "Wrong leader type", memberIds: [leader], leaderMemberId: 7 },
      { name: "Wrong leader format", memberIds: [leader], leaderMemberId: "strict-room-leader" },
      { name: "Wrong description", memberIds: [leader], description: null },
      { name: "Wrong docs path", memberIds: [leader], docsPath: 7 },
    ]) {
      const rejected = await request("POST", "/api/rooms", body);
      expect(rejected.status, `${JSON.stringify(body)}: ${rejected.body}`).toBe(400);
    }
    expect(JSON.parse((await request("GET", "/api/rooms")).body)).toEqual(roomsBefore);
    expect((await request("POST", "/api/rooms", {
      name: "Missing member", memberIds: [missing], leaderMemberId: missing,
    })).status).toBe(404);

    const created = await request("POST", "/api/rooms", {
      name: "Strict room", memberIds: [leader, peer], leaderMemberId: leader,
      description: "Canonical body", docsPath: "strict/docs",
    });
    expect(created.status, created.body).toBe(200);
    const room = JSON.parse(created.body);
    const roomPath = `/api/rooms/${room.id}`;
    const stableRoomFields = (value: any) => ({
      name: value.name,
      description: value.description,
      docsPath: value.docsPath,
      promptLeaderMemberId: value.promptLeaderMemberId,
      memberIds: value.memberIds,
    });
    const beforePatch = stableRoomFields(room);

    for (const body of [
      ["not-an-object"],
      {},
      { cwd: "/retired" },
      { name: "Strict room", ruleDocs: [] },
      { name: 7 },
      { name: "   " },
      { description: 7 },
      { promptLeaderMemberId: 7 },
      { promptLeaderMemberId: "strict-room-outsider" },
      { docsPath: 7 },
    ]) {
      const rejected = await request("PATCH", roomPath, body);
      expect(rejected.status, `${JSON.stringify(body)}: ${rejected.body}`).toBe(400);
    }
    expect(stableRoomFields(JSON.parse((await request("GET", roomPath)).body))).toEqual(beforePatch);
    expect((await request("PATCH", roomPath, { promptLeaderMemberId: missing })).status).toBe(404);
    expect((await request("PATCH", roomPath, { promptLeaderMemberId: outsider })).status).toBe(400);
    const same = await request("PATCH", roomPath, {
      name: room.name,
      description: room.description,
      docsPath: room.docsPath,
      promptLeaderMemberId: room.promptLeaderMemberId,
    });
    expect(same.status, same.body).toBe(200);
    expect(stableRoomFields(JSON.parse(same.body))).toEqual(beforePatch);

    const membersPath = `${roomPath}/members`;
    for (const body of [
      ["not-an-object"],
      {},
      { memberId: outsider, agent: "retired" },
      { memberId: 7 },
      { memberId: "strict-room-outsider" },
      { memberId: ` ${outsider}` },
    ]) {
      const rejected = await request("POST", membersPath, body);
      expect(rejected.status, `${JSON.stringify(body)}: ${rejected.body}`).toBe(400);
    }
    expect(JSON.parse((await request("GET", roomPath)).body).memberIds).toEqual([leader, peer]);
    expect((await request("POST", membersPath, { memberId: missing })).status).toBe(404);
    const invited = await request("POST", membersPath, { memberId: outsider });
    expect(invited.status, invited.body).toBe(200);
    expect(JSON.parse(invited.body).memberIds).toEqual([leader, peer, outsider]);
  } finally {
    await closeTestServer(test);
  }
});
