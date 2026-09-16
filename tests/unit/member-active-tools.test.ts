import { createMember, findMemberByName } from "../../src/member/member-registry.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  closeTestServer,
  createTestServer,
  getTestBossmodeDir,
  jsonRequest,
  loginAndGetToken,
  setupTestWorkspace,
} from "../helpers/test-server.js";

setupTestWorkspace();

describe("member active tools", () => {
  const servers: Awaited<ReturnType<typeof createTestServer>>[] = [];

  afterEach(async () => {
    while (servers.length) await closeTestServer(servers.pop()!);
  });

  it("returns empty session when member has no running instance", async () => {
    const roomStore = await import("../../src/chat/room-store.js");
    const agentManager = await import("../../src/agent/orchestrator/agent-manager.js");
    const room = roomStore.createRoom("Tools Room", getTestBossmodeDir(), [(findMemberByName("pm") ?? createMember({ name: "pm" })).id]);
    const result = agentManager.getMemberActiveTools(room.id, "pm");
    expect(result.sessionActive).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.message).toMatch(/Start or Reload/i);
  });

  it("API route returns 404 for unknown room/member and empty for idle member", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await loginAndGetToken(ts.port);

    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.createRoom("API Tools", getTestBossmodeDir(), [(findMemberByName("pm") ?? createMember({ name: "pm" })).id]);

    const missRoom = await jsonRequest(ts.port, "GET", "/api/rooms/nope/members/pm/tools", { token });
    expect(missRoom.status).toBe(404);

    const missMember = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/ghost/tools`, { token });
    expect(missMember.status).toBe(404);

    const idle = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/pm/tools`, { token });
    expect(idle.status).toBe(200);
    const body = JSON.parse(idle.body);
    expect(body.sessionActive).toBe(false);
    expect(body.tools).toEqual([]);
    expect(String(body.message || "")).toMatch(/Start or Reload/i);
  });
});
