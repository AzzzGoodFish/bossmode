import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("Authenticated member panel scope APIs", () => {
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

  async function createMember(name: string): Promise<{ memberId: string; name: string }> {
    const res = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name, agentTemplate: "pm" },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.member.memberId).toBe("string");
    return { memberId: body.member.memberId, name };
  }

  it("serves scoped SQL stats and activity pages for room, DM and topic, ignoring old files", async () => {
    const { memberId } = await createMember("panel-stats");
    const created = await jsonRequest(ts.port, "POST", "/api/rooms", { token, body: { name: "Panel", memberIds: [memberId] } });
    expect(created.status).toBe(200);
    const room = JSON.parse(created.body);
    const { createTopic } = await import("../../src/workspace/topic-store.js");
    const topic = createTopic({ roomId: room.id, title: "Panel topic", anchorMessageId: "anchor", seedMode: "fresh" });
    const { appendAgentEvent, readAgentEvents } = await import("../../src/storage/event-repository.js");
    const scopes = [
      { id: room.id, api: `room:${room.id}`, path: `rooms/${room.id}` },
      { id: `dm:${memberId}`, api: `dm:${memberId}`, path: `rooms/dm:${memberId}` },
      { id: `topic:${topic.id}`, api: `topic:${topic.id}`, path: `rooms/${room.id}/topics/${topic.id}` },
    ];
    for (const [index, scope] of scopes.entries()) {
      const value = index + 1;
      const events = [
        { type: "agent_start", ts: 100 },
        { type: "message_end", ts: 200, usage: { inputTokens: value, outputTokens: value * 2, cost: value / 100 } },
        { type: "agent_reply", ts: 300, text: `reply-${scope.id}` },
        { type: "agent_end", ts: 400 },
      ];
      events.forEach((event, i) => appendAgentEvent(scope.id, { ownerKey: memberId, memberId }, event, `${scope.id}-${i}`));
      const dir = join(getTestBossmodeDir(), scope.path, "agent-events");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${memberId}.stats.json`), "not-json");
      writeFileSync(join(dir, `${memberId}.jsonl`), '{"type":"system","text":"poison"}\n');
      const query = encodeURIComponent(scope.api);
      const response = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=${query}`, { token });
      expect(response.status, response.body).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ turns: 1, cost: value / 100, tokens: { input: value, output: value * 2 } });
      const result = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/events?scope=${query}&limit=2`, { token });
      expect(result.status, result.body).toBe(200);
      const page = JSON.parse(result.body);
      expect(page).toMatchObject({ hasMore: true, nextBeforeSeq: 2 });
      expect(page.events).toEqual([events[1], events[3]]);
      const older = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/events?scope=${query}&limit=2&beforeSeq=${page.nextBeforeSeq}`, { token });
      expect(older.status).toBe(200);
      expect(JSON.parse(older.body)).toMatchObject({ events: [events[0]], hasMore: false, nextBeforeSeq: null });
      // The activity filter must not discard the full non-activity event fact.
      expect(readAgentEvents(scope.id, memberId)).toEqual(events);
    }
  });

  it("model config is single-path: /config is gone, PATCH /:id writes global via the switch", async () => {
    const { memberId } = await createMember("patchflow");
    const scope = `dm:${memberId}`;

    // The retired /config route is a plain 404.
    const p1 = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config?scope=${encodeURIComponent(scope)}`, {
      token,
      body: { model: "global-model-x" },
    });
    expect(p1.status).toBe(404);

    // The single path: PATCH /api/members/:id — requires a full model+credential
    // binding and a real credential, so a bare unresolvable model is rejected.
    const p2 = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { model: "global-model-x" },
    });
    expect(p2.status).toBe(400);
    expect(JSON.parse(p2.body).error).toBe("invalid_binding");

    const eff = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/effective-config?scope=${encodeURIComponent(scope)}`, { token });
    expect(eff.status).toBe(200);
    expect(JSON.parse(eff.body).model ?? null).toBeNull();
  });

  it("scope param validation: invalid scope → 400, missing scope → 400", async () => {
    const { memberId } = await createMember("scopevalid");
    const bad = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=nonsense`, { token });
    expect(bad.status).toBe(400);
    const missing = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats`, { token });
    expect(missing.status).toBe(400);
  });
});
