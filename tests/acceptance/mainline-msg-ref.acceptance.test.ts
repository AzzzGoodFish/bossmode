/**
 * 体验批② acceptance — mainline msg refs enriched over HTTP (members memory
 * route) + DM messages around-window jump support.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestWorkspace,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  getTestBossmodeDir,
} from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

import { resetMocks } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: mainline msg refs + DM jump (体验批②)", () => {
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

  it("resolves a DM message jump by ID and returns an empty window for a missing target", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "dm-jump" } });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId;
    let targetId = "";
    for (let i = 1; i <= 5; i++) {
      const sent = await jsonRequest(ts.port, "POST", `/api/dm/${memberId}/messages`, { token, body: { text: `dm message ${i}` } });
      expect(sent.status).toBe(200);
      if (i === 3) targetId = JSON.parse(sent.body).message.id;
    }
    const around = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages?around=${targetId}&limit=50`, { token });
    expect(around.status).toBe(200);
    const messages = JSON.parse(around.body).messages;
    expect(messages.some((message: any) => message.id === targetId)).toBe(true);
    expect(messages.filter((message: any) => message.content.startsWith("dm message"))).toHaveLength(5);
    const missing = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages?around=missing&limit=50`, { token });
    expect(missing.status).toBe(200);
    expect(JSON.parse(missing.body).messages).toEqual([]);
  });

  it("room mainline route enriches msg entries (msgId+summary) for the panel", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm" } });
    const memberId = JSON.parse(created.body).member.memberId;

    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "r", memberIds: [memberId] },
    });
    expect(roomRes.status).toBe(200);
    const room = JSON.parse(roomRes.body);
    const roomScope = `room:${room.id}`;

    const sent = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "room decision msg" } });
    const msg = JSON.parse(sent.body);

    const ml = await import("../../src/member/member-memory-store.js");
    ml.writeMemoryLayer(memberId, "mainline", `## Focus\nX\n\n## Dynamic Index\n- msg:#${msg.seq} — decision\n`, { type: "user" }, { scopeId: roomScope });

    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/pm/mainline`, { token });
    expect(res.status).toBe(200);
    const entry = JSON.parse(res.body).parsed.index.find((e: any) => e.kind === "msg");
    expect(entry.stale).toBe(false);
    expect(entry.msgId).toBe(msg.id);
    expect(entry.summary).toContain("room decision");
  });
});
