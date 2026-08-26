/**
 * 0.20 flagship ② — unified member panel scope-addressed APIs (acceptance).
 *
 * The DM panel is the room's MemberConfigPanel fed by members-shaped routes
 * with a scope parameter (?scope=room:<id>|dm:<memberId>). These tests pin:
 * - GET /api/members/:id/stats?scope= — reads the scope's stats artifact
 * - GET /api/members/:id/events?scope= — reads the scope's event stream
 * - GET /api/members/:id/memory?layer&scope= — rich payload (revision/hash/
 *   budget header/parsed) matching the room members routes
 * - PATCH /api/members/:id/config?scope= — unified write authority:
 *   unifiedModel fields go global, otherwise the scope override
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("Acceptance: panel scope-addressed APIs (0.20 flagship ②)", () => {
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
    return { memberId: body.member?.memberId || body.memberId || body.member?.id, name };
  }

  it("stats route reads the dm scope artifact (rooms/dm:<id>/agent-events)", async () => {
    const { memberId } = await createMember("statsdm");
    const dir = getTestBossmodeDir();
    const eventsDir = join(dir, "rooms", `dm:${memberId}`, "agent-events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, `${memberId}.stats.json`),
      JSON.stringify({ turns: 7, toolCalls: 3, activeMs: 4200, tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0.5 }),
      "utf-8",
    );

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=${encodeURIComponent(`dm:${memberId}`)}`, { token });
    expect(res.status).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats.turns).toBe(7);
    expect(stats.cost).toBe(0.5);
  });

  it("stats route reads the room scope artifact via scope=room:<id>", async () => {
    const { memberId } = await createMember("statsroom");
    const dir = getTestBossmodeDir();
    const eventsDir = join(dir, "rooms", "room-xyz", "agent-events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, `${memberId}.stats.json`),
      JSON.stringify({ turns: 2, toolCalls: 1, activeMs: 100, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 }),
      "utf-8",
    );

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=${encodeURIComponent("room:room-xyz")}`, { token });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).turns).toBe(2);
  });

  it("events route pages the dm scope event stream", async () => {
    const { memberId } = await createMember("eventsdm");
    const dir = getTestBossmodeDir();
    const eventsDir = join(dir, "rooms", `dm:${memberId}`, "agent-events");
    mkdirSync(eventsDir, { recursive: true });
    const events = [
      { type: "user_steer", text: "hello", ts: 1000 },
      { type: "agent_reply", text: "hi there", ts: 2000 },
      { type: "system", text: "note", ts: 3000 },
    ];
    writeFileSync(join(eventsDir, `${memberId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/events?scope=${encodeURIComponent(`dm:${memberId}`)}&limit=50`, { token });
    expect(res.status).toBe(200);
    const page = JSON.parse(res.body);
    expect(Array.isArray(page.events)).toBe(true);
    expect(page.events.length).toBe(3);
    expect(page.events.some((e: any) => e.text === "hi there")).toBe(true);
  });

  it.skip("memory route principles/mainline retired", async () => {
    const { memberId } = await createMember("memrich");
    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/memory?layer=principles&scope=${encodeURIComponent(`dm:${memberId}`)}`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("content");
    expect(body).toHaveProperty("revision");
    expect(body).toHaveProperty("contentHash");
    expect(body).toHaveProperty("budgetHeader");
    // Empty asset → starter template suggested (same contract as the room route)
    expect(body.suggestedTemplate).toBeTruthy();

    const main = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/memory?layer=mainline&scope=${encodeURIComponent(`dm:${memberId}`)}`, { token });
    expect(main.status).toBe(200);
    expect(JSON.parse(main.body)).toHaveProperty("parsed");
  });

  it("PATCH config: unifiedModel member writes global; scope-overriding member writes the dm scope override", async () => {
    const { memberId } = await createMember("patchflow");
    const scope = `dm:${memberId}`;

    // Default member is unifiedModel=true → global write, no scope override
    const p1 = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config?scope=${encodeURIComponent(scope)}`, {
      token,
      body: { model: "global-model-x" },
    });
    expect(p1.status).toBe(200);
    let detail = await jsonRequest(ts.port, "GET", `/api/members/${memberId}`, { token });
    let member = JSON.parse(detail.body).member;
    expect(member.global.model).toBe("global-model-x");
    expect(member.scopeOverrides?.[scope]).toBeUndefined();

    // Flip to scope-overriding → next patch lands in the dm scope override
    const flip = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { unifiedModel: false },
    });
    expect(flip.status).toBe(200);
    const p2 = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config?scope=${encodeURIComponent(scope)}`, {
      token,
      body: { model: "dm-model-y" },
    });
    expect(p2.status).toBe(200);
    detail = await jsonRequest(ts.port, "GET", `/api/members/${memberId}`, { token });
    member = JSON.parse(detail.body).member;
    expect(member.scopeOverrides?.[scope]?.model).toBe("dm-model-y");
    expect(member.global.model).toBe("global-model-x");

    // Effective config in the dm scope resolves the override
    const eff = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/effective-config?scope=${encodeURIComponent(scope)}`, { token });
    expect(eff.status).toBe(200);
    expect(JSON.parse(eff.body).model).toBe("dm-model-y");
  });

  it("scope param validation: invalid scope → 400, missing scope → 400", async () => {
    const { memberId } = await createMember("scopevalid");
    const bad = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=nonsense`, { token });
    expect(bad.status).toBe(400);
    const missing = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats`, { token });
    expect(missing.status).toBe(400);
  });
});
