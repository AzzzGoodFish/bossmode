import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { readStats } from "../../src/data/repositories/event-repository.js";
let fixture: ReturnType<typeof coreFixture>;

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToAgentSubscribers: vi.fn(),
}));

const agentManagerMocks = vi.hoisted(() => ({
  refreshContextUsage: vi.fn(),
}));
vi.mock("../../src/agent/orchestrator/agent-manager.js", () => ({
  refreshContextUsage: agentManagerMocks.refreshContextUsage,
}));

vi.mock("../../src/agent/events/knowledge-activity.js", () => ({
  maybeEmitKnowledgeActivity: vi.fn(),
}));

function usageEvent(usage: Record<string, number>) {
  return { type: "message_end" as const, text: "hi", usage };
}

async function loadModules() {
  const eh = await import("../../src/agent/events/event-handler.js");
  return { eh, db: fixture.db };
}

describe("model stamps and atomic SQL usage", () => {
  beforeEach(() => {
    fixture = coreFixture();
    fixture.db.run("INSERT INTO scopes VALUES('room1','room','room1',NULL)");
    agentManagerMocks.refreshContextUsage.mockReset();
  });
  afterEach(async () => {
    await new Promise<void>(resolve => queueMicrotask(resolve));
    fixture.close();
  });

  it("stamps top-level model on the persisted message_end", async () => {
    const { eh } = await loadModules();
    const buffer: any[] = [];
    eh.handleAgentEvent(
      "room1",
      "developer",
      "room1:developer",
      usageEvent({ inputTokens: 100, outputTokens: 10 }),
      buffer,
      "rm_dev1",
      "claude-cloud/claude-opus-4-8",
    );

    const persisted = eh.loadEventsFromDisk("room1", "rm_dev1");
    const end = persisted.find((e: any) => e.type === "message_end") as any;
    expect(end.model).toBe("claude-cloud/claude-opus-4-8");
  });

  it("omits model when none is known (pre-stamp / unknown)", async () => {
    const { eh } = await loadModules();
    const buffer: any[] = [];
    eh.handleAgentEvent(
      "room1",
      "developer",
      "room1:developer",
      usageEvent({ inputTokens: 5 }),
      buffer,
      "rm_dev1",
      undefined,
    );
    const persisted = eh.loadEventsFromDisk("room1", "rm_dev1");
    const end = persisted.find((e: any) => e.type === "message_end") as any;
    expect("model" in end).toBe(false);
  });

  it("adds distinct final events under the stamped model", async () => {
    const { eh, db } = await loadModules();

    const buffer: any[] = [];
    const model = "kimi-coding/k3";
    eh.handleAgentEvent("room1", "pm", "room1:pm", usageEvent({ inputTokens: 100, outputTokens: 10, cacheRead: 40, cost: 0.5 }), buffer, "rm_pm", model);
    eh.handleAgentEvent("room1", "pm", "room1:pm", usageEvent({ inputTokens: 50, outputTokens: 5, cacheRead: 10, cost: 0.25 }), buffer, "rm_pm", model);

    const row = db.get<{ input_tokens: number; output_tokens: number; cache_read: number; cost: number; turns: number; model: string }>(
      "SELECT input_tokens, output_tokens, cache_read, cost, turns, model FROM token_usage_daily WHERE room_id = 'room1' AND member_id = 'rm_pm'",
    );
    expect(row?.model).toBe("kimi-coding/k3");
    expect(row?.input_tokens).toBe(150);
    expect(row?.output_tokens).toBe(15);
    expect(row?.cache_read).toBe(50);
    expect(row?.cost).toBeCloseTo(0.75);
    expect(row?.turns).toBe(2);
  });

  it("routes unstamped usage to the 'unknown' model bucket", async () => {
    const { eh, db } = await loadModules();

    const buffer: any[] = [];
    eh.handleAgentEvent("room1", "qa", "room1:qa", usageEvent({ inputTokens: 7 }), buffer, "rm_qa", undefined);

    const row = db.get<{ model: string; input_tokens: number }>(
      "SELECT model, input_tokens FROM token_usage_daily WHERE member_id = 'rm_qa'",
    );
    expect(row?.model).toBe("unknown");
    expect(row?.input_tokens).toBe(7);
  });

  it("updates readStats additively including cache, cost and completed turns", async () => {
    const { eh } = await loadModules();
    const buffer: any[] = [];
    for (const n of [1, 2]) {
      eh.handleAgentEvent("room1", "dev", "room1:dev", usageEvent({ inputTokens: 30 * n, outputTokens: 3 * n, cacheRead: 4 * n, cacheWrite: 5 * n, cost: 0.25 * n }), buffer, "rm_s", "prov/m");
      eh.handleAgentEvent("room1", "dev", "room1:dev", { type: "agent_end" }, buffer, "rm_s", "prov/m");
    }
    expect(readStats("room1", "rm_s")).toMatchObject({ turns: 2, tokens: { input: 90, output: 9, cacheRead: 12, cacheWrite: 15 }, cost: 0.75 });
  });

  it("fails closed without authority rather than reporting file-only success", async () => {
    const { eh } = await loadModules();
    fixture.db.close();
    const buffer: any[] = [];
    expect(() => eh.handleAgentEvent("room1", "dev", "room1:dev", usageEvent({ inputTokens: 1 }), buffer, "rm_none", "prov/m")).toThrow("not initialized");
    expect(buffer).toEqual([]);
  });
});
