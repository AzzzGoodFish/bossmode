import { expect, it } from "vitest";
import {
  closeTestServer,
  createTestServer,
  jsonRequest,
  setupTestWorkspace,
} from "./helpers/test-server.js";

setupTestWorkspace();

it("maps only system-prompt source validation failures to invalid_scope", async () => {
  const test = await createTestServer();
  try {
    const login = await jsonRequest(test.port, "POST", "/api/auth/login", {
      body: { username: "testuser", password: "testpass" },
    });
    const token = JSON.parse(login.body).token as string;
    const request = (path: string) => jsonRequest(test.port, "GET", path, { token });
    const createMember = async (name: string): Promise<string> => {
      const response = await jsonRequest(test.port, "POST", "/api/members", { token, body: { name } });
      expect(response.status, response.body).toBe(200);
      return JSON.parse(response.body).member.memberId;
    };
    const memberId = await createMember("prompt-scope-member");
    const outsiderId = await createMember("prompt-scope-outsider");
    const createdRoom = await jsonRequest(test.port, "POST", "/api/rooms", {
      token,
      body: { name: "Prompt scope room", memberIds: [memberId], leaderMemberId: memberId },
    });
    expect(createdRoom.status, createdRoom.body).toBe(200);
    const roomId = JSON.parse(createdRoom.body).id as string;

    const unscoped = await request(`/api/members/${memberId}/system-prompt`);
    expect(unscoped.status, unscoped.body).toBe(200);
    expect(JSON.parse(unscoped.body)).toEqual({
      available: false,
      reason: "instance_not_running",
      scopeId: null,
    });

    for (const scope of [`dm:${memberId}`, `room:${roomId}`]) {
      const allowed = await request(`/api/members/${memberId}/system-prompt?scope=${encodeURIComponent(scope)}`);
      expect(allowed.status, allowed.body).toBe(200);
      expect(JSON.parse(allowed.body)).toEqual({
        available: false,
        reason: "instance_not_running",
        scopeId: scope,
      });
    }

    for (const [id, scope] of [
      [memberId, "nonsense"],
      [memberId, "topic:retired"],
      [memberId, `dm:${outsiderId}`],
      [outsiderId, `room:${roomId}`],
    ]) {
      const rejected = await request(`/api/members/${id}/system-prompt?scope=${encodeURIComponent(scope)}`);
      expect(rejected.status, `${scope}: ${rejected.body}`).toBe(400);
      expect(JSON.parse(rejected.body)).toMatchObject({ error: "invalid_scope" });
    }

    const missing = await request("/api/members/mem_does-not-exist/system-prompt?scope=dm%3Amem_does-not-exist");
    expect(missing.status, missing.body).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ error: "not_found" });

    const { connectMemberHttpActions } = await import("../src/api/members.js");
    let failRead = false;
    let currentPrompt = {
      available: true as const,
      text: "SDK current text",
      contractFingerprint: "actual-text-fingerprint",
    };
    const disconnect = connectMemberHttpActions({
      readCurrentPrompt: () => {
        if (failRead) throw new Error("prompt read exploded");
        return currentPrompt;
      },
      readStats: () => ({}),
      readTokenTotal: () => 0,
      readActivity: () => [],
      stop: () => undefined,
      compact: () => undefined,
      reset: () => undefined,
      restart: () => undefined,
    });
    try {
      const available = await request(`/api/members/${memberId}/system-prompt?scope=dm%3A${memberId}`);
      expect(available.status, available.body).toBe(200);
      expect(JSON.parse(available.body)).toEqual({
        available: true,
        text: currentPrompt.text,
        charCount: currentPrompt.text.length,
        scopeId: `dm:${memberId}`,
        contractFingerprint: currentPrompt.contractFingerprint,
      });

      failRead = true;
      const failedRead = await request(`/api/members/${memberId}/system-prompt`);
      expect(failedRead.status, failedRead.body).toBe(500);
      expect(JSON.parse(failedRead.body)).toMatchObject({ error: "internal", message: "prompt read exploded" });
    } finally {
      disconnect();
    }
  } finally {
    await closeTestServer(test);
  }
});
