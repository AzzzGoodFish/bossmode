/**
 * 体验批② acceptance — mainline msg refs enriched over HTTP (members memory
 * route) + DM messages around-window jump support.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupConfigMock,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  getTestBossmodeDir,
} from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

import { resetMocks } from "../helpers/mock-runtime.js";

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn().mockImplementation((name: string) => ({
    id: name, name, type: "agent", agent: name,
    model: "mock-model", runtime: "mock", skills: [], thinkingLevel: "off",
  })),
  loadMembers: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name, model: "mock-model", description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`, skills: [], tags: [],
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "mock-model", description: "PM agent", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

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

  it("DM mainline msg refs resolve and carry msgId+summary; around window serves the jump", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "architect", agentTemplate: "pm" } });
    const memberId = JSON.parse(created.body).member.memberId;
    const scope = `dm:${memberId}`;

    // Seed DM conversation (5 messages) via the API
    let targetId = "";
    for (let i = 1; i <= 5; i++) {
      const sent = await jsonRequest(ts.port, "POST", `/api/dm/${memberId}/messages`, { token, body: { content: `dm message ${i}` } });
      const msg = JSON.parse(sent.body).message;
      if (i === 3) targetId = msg.id;
    }

    // Write mainline with a msg ref pointing at the third message's seq
    const ml = await import("../../src/workspace/member-memory-store.js");
    const dm = await import("../../src/workspace/dm-message-store.js");
    const messages = dm.readAllDmMessages(memberId);
    const target = messages.find((m) => m.id === targetId)!;
    const { writeMemoryLayer } = ml;
    writeMemoryLayer(memberId, "mainline", `## Focus\nJump\n\n## Dynamic Index\n- msg:#${target.seq} — the dm decision\n- msg:#999999 — gone\n`, { type: "user" }, { scopeId: scope });

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/memory?layer=mainline&scope=${encodeURIComponent(scope)}`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const entries = body.parsed.index.filter((e: any) => e.kind === "msg");
    const live = entries.find((e: any) => e.ref === `msg:#${target.seq}`)!;
    expect(live.stale).toBe(false);
    expect(live.msgId).toBe(targetId);
    expect(live.summary).toContain("dm message 3");
    const gone = entries.find((e: any) => e.ref === "msg:#999999")!;
    expect(gone.stale).toBe(true);
    expect(gone.msgId).toBeUndefined();

    // Around window: fetching around the target returns a centered slice containing it
    const around = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages?around=${targetId}&limit=50`, { token });
    expect(around.status).toBe(200);
    const win = JSON.parse(around.body).messages;
    expect(win.length).toBeGreaterThanOrEqual(5); // all messages fit the window (+ mock notices)
    expect(win.filter((m: any) => m.content.startsWith("dm message")).length).toBe(5);
    expect(win.some((m: any) => m.id === targetId)).toBe(true);

    // Unknown around id → empty window (client treats as no-op jump)
    const missing = await jsonRequest(ts.port, "GET", `/api/dm/${memberId}/messages?around=does-not-exist&limit=50`, { token });
    expect(JSON.parse(missing.body).messages).toEqual([]);
  });

  it("room mainline route enriches msg entries (msgId+summary) for the panel", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", agentTemplate: "pm" } });
    const memberId = JSON.parse(created.body).member.memberId;

    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "r", cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm" },
    });
    const room = JSON.parse(roomRes.body);
    const roomScope = `room:${room.id}`;

    const sent = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "room decision msg" } });
    const msg = JSON.parse(sent.body);

    const ml = await import("../../src/workspace/member-memory-store.js");
    ml.writeMemoryLayer(memberId, "mainline", `## Focus\nX\n\n## Dynamic Index\n- msg:#${msg.seq} — decision\n`, { type: "user" }, { scopeId: roomScope });

    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/pm/mainline`, { token });
    expect(res.status).toBe(200);
    const entry = JSON.parse(res.body).parsed.index.find((e: any) => e.kind === "msg");
    expect(entry.stale).toBe(false);
    expect(entry.msgId).toBe(msg.id);
    expect(entry.summary).toContain("room decision");
  });
});
