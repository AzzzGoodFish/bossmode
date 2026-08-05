/**
 * F5 migration acceptance — end-to-end over the panel read routes:
 * a legacy-keyed room (bare name + rm_ + mem_ artifacts with stale stats
 * caches) is migrated by the rekey migration; afterwards the members-shaped
 * stats/events routes serve the single mem_ key with the FULL history (the
 * designer-alignment "0 turns" regression), stats re-derived in the same run,
 * and re-running the migration is a no-op.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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

describe("Acceptance: F5 agent-events rekey migration", () => {
  let ts: TestServer;
  let token: string;
  let memberId: string;
  const roomId = "room-legacy-f5";

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

  it("rekeys legacy artifacts then serves the full history under the single mem_ key", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "architect", agentTemplate: "pm" },
    });
    memberId = JSON.parse(res.body).member.memberId;

    const dir = getTestBossmodeDir();
    const roomDir = join(dir, "rooms", roomId);
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(join(roomDir, "room.json"), JSON.stringify({
      id: roomId, name: roomId, cwd: dir, members: ["architect"],
      roomMembers: [{ id: "rm_legacy", roomId, name: "architect", sourceAgent: "pm", sourceMemberId: memberId, createdAt: Date.now(), updatedAt: Date.now() }],
      globalMemberIds: [memberId], createdAt: Date.now(),
    }), "utf-8");
    const evd = join(roomDir, "agent-events");
    mkdirSync(evd, { recursive: true });

    // name-keyed history (pre-0.20, 2 events with 1 completed turn) + rm_ key (1 event)
    writeFileSync(join(evd, "architect.jsonl"), [
      { type: "agent_start", ts: 1000 },
      { type: "agent_end", ts: 1500 },
      { type: "agent_reply", ts: 2000, text: "old reply" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    writeFileSync(join(evd, "architect.stats.json"), JSON.stringify({ turns: 99, toolCalls: 99, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }), "utf-8");
    writeFileSync(join(evd, "rm_legacy.jsonl"), JSON.stringify({ type: "agent_start", ts: 3000 }) + "\n", "utf-8");
    writeFileSync(join(evd, `${memberId}.jsonl`), [
      { type: "agent_start", ts: 3500 },
      { type: "agent_end", ts: 4000 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    writeFileSync(join(evd, `${memberId}.stats.json`), JSON.stringify({ turns: 1, toolCalls: 1, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }), "utf-8");

    // Run the migration (in production it runs at startup, after projection init)
    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();
    expect(result.roomsWithChanges).toBe(1);
    expect(result.filesRenamed).toBe(0); // no pure renames — both legacy keys merge into the existing mem jsonl
    expect(result.filesMerged).toBe(2);  // architect name + rm_legacy → mem
    expect(result.statsCachesRemoved).toBe(2); // both stale caches discarded
    expect(result.orphans).toEqual([]);

    // Legacy key files gone; single mem_ key remains with ALL events
    expect(existsSync(join(evd, "architect.jsonl"))).toBe(false);
    expect(existsSync(join(evd, "rm_legacy.jsonl"))).toBe(false);
    expect(existsSync(join(evd, "architect.stats.json"))).toBe(false);
    const memLines = readFileSync(join(evd, `${memberId}.jsonl`), "utf-8").split("\n").filter(Boolean);
    expect(memLines.length).toBe(6); // 3 (name) + 1 (rm_legacy) + 2 (existing mem)

    // Stats route: re-derived in the same run, real numbers (2 completed turns)
    const stats = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/stats?scope=${encodeURIComponent(`room:${roomId}`)}`, { token });
    expect(stats.status).toBe(200);
    expect(JSON.parse(stats.body).turns).toBe(2);

    // Events route: full ts-ordered stream under the single mem_ key
    const events = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/events?scope=${encodeURIComponent(`room:${roomId}`)}&limit=50`, { token });
    expect(events.status).toBe(200);
    const page = JSON.parse(events.body);
    expect(page.events.length).toBe(6);
    expect(page.events.map((e: any) => e.ts)).toEqual([1000, 1500, 2000, 3000, 3500, 4000]);

    // Re-run is a no-op
    const again = runAgentEventsRekeyMigration();
    expect(again.roomsWithChanges).toBe(0);
    expect(readdirSync(evd).filter((f) => f.endsWith(".jsonl"))).toEqual([`${memberId}.jsonl`]);
  });
});
