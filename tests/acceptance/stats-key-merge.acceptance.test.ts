/**
 * 0.20 read-side key merge — acceptance over HTTP (designer alignment finding,
 * real-data-equivalent fixture): a room whose member has BOTH pre-0.20
 * name-keyed artifacts and post-0.20 mem_-keyed artifacts must show the union
 * on the panel APIs, never a falsifying "0 turns".
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

describe("Acceptance: stats/events read-side key merge (pre-F5)", () => {
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

  it("panel APIs merge mem_ + name keyed artifacts (the fish dev-room shape)", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "architect", agentTemplate: "pm" },
    });
    expect(res.status).toBe(200);
    const memberId = JSON.parse(res.body).member.memberId;
    const roomId = "room-legacy-1";
    const dir = join(getTestBossmodeDir(), "rooms", roomId, "agent-events");
    mkdirSync(dir, { recursive: true });

    // pre-0.20 name-keyed history (the 25k-line reality) + post-0.20 mem_ key
    writeFileSync(join(dir, "architect.stats.json"), JSON.stringify({ turns: 120, toolCalls: 300, activeMs: 60000, tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 }, cost: 3.5 }), "utf-8");
    writeFileSync(join(dir, `${memberId}.stats.json`), JSON.stringify({ turns: 3, toolCalls: 9, activeMs: 1500, tokens: { input: 50, output: 60, cacheRead: 0, cacheWrite: 0 }, cost: 0.1 }), "utf-8");
    writeFileSync(join(dir, "architect.jsonl"), [
      { type: "agent_start", ts: 1000 },
      { type: "agent_reply", ts: 3000, text: "pre-0.20 reply" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    writeFileSync(join(dir, `${memberId}.jsonl`), [
      { type: "agent_start", ts: 2000 },
      { type: "agent_reply", ts: 4000, text: "post-0.20 reply" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

    // stats: union, never the falsifying "3 turns" or "0 turns"
    const stats = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=${encodeURIComponent(`room:${roomId}`)}`, { token });
    expect(stats.status).toBe(200);
    const s = JSON.parse(stats.body);
    expect(s.turns).toBe(123);
    expect(s.toolCalls).toBe(309);
    expect(s.cost).toBeCloseTo(3.6, 5);

    // events: ts-merged union across both key forms
    const events = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/events?scope=${encodeURIComponent(`room:${roomId}`)}&limit=50`, { token });
    expect(events.status).toBe(200);
    const page = JSON.parse(events.body);
    expect(page.events.length).toBe(4);
    expect(page.events.map((e: any) => e.ts)).toEqual([1000, 2000, 3000, 4000]);
    expect(page.events.some((e: any) => e.text === "pre-0.20 reply")).toBe(true);
    expect(page.events.some((e: any) => e.text === "post-0.20 reply")).toBe(true);
  });
});
