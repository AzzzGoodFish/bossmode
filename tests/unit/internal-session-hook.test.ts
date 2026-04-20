import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest } from "../helpers/test-server.js";
import * as sessionStore from "../../src/workspace/session-store.js";

setupConfigMock();

describe("/internal/session-hook", () => {
  let ts: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    ts = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(ts);
  });

  it("saves latest claude session id", async () => {
    const roomId = "room-hook-test";
    const agentName = "developer";

    const res = await jsonRequest(ts.port, "POST", "/internal/session-hook", {
      body: { session_id: "sess-123", roomId, agentName },
    });

    expect(res.status).toBe(200);
    const sessions = sessionStore.getSessions(roomId);
    expect(sessions[agentName]).toEqual({ runtime: "claude-cli", sessionId: "sess-123" });
  });

  it("validates required fields", async () => {
    const res = await jsonRequest(ts.port, "POST", "/internal/session-hook", {
      body: { roomId: "r1", agentName: "developer" },
    });
    expect(res.status).toBe(400);
  });
});
