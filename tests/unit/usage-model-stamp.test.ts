import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// S2: model stamp on message_end + token_usage_daily dual-write.
//
// event-handler writes to disk (file authority) AND upserts the SQLite rollup.
// These tests assert the stamp lands on disk, the rollup increments additively,
// the 'unknown' bucket is used when no model is known, and the existing
// stats.json accumulator still updates (no regression).

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => {
    mkdirSync(dir, { recursive: true });
  },
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToAgentSubscribers: vi.fn(),
}));

const agentManagerMocks = vi.hoisted(() => ({
  refreshContextUsage: vi.fn(),
}));
vi.mock("../../src/engine/agent-manager.js", () => ({
  refreshContextUsage: agentManagerMocks.refreshContextUsage,
}));

vi.mock("../../src/engine/knowledge-activity.js", () => ({
  maybeEmitKnowledgeActivity: vi.fn(),
}));

function usageEvent(usage: Record<string, number>) {
  return { type: "message_end" as const, text: "hi", usage };
}

async function loadModules() {
  const eh = await import("../../src/engine/event-handler.js");
  const sqlite = await import("../../src/workspace/db/sqlite.js");
  const projection = await import("../../src/workspace/db/projection.js");
  return { eh, sqlite, projection };
}

describe("S2 usage model-stamp + rollup dual-write", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-s2-"));
    mkdirSync(join(dir, "rooms", "room1", "agent-events"), { recursive: true });
    vi.resetModules();
    agentManagerMocks.refreshContextUsage.mockReset();
  });

  afterEach(async () => {
    try {
      const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
      resetDbCache();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
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

  it("dual-writes token_usage_daily additively under the stamped model", async () => {
    const { eh, sqlite, projection } = await loadModules();
    // Initialize the projection DB so recordDailyUsage has a target.
    projection.initProjection(join(dir, "bossmode.db"));
    const db = sqlite.openDb(join(dir, "bossmode.db"));

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
    const { eh, sqlite, projection } = await loadModules();
    projection.initProjection(join(dir, "bossmode.db"));
    const db = sqlite.openDb(join(dir, "bossmode.db"));

    const buffer: any[] = [];
    eh.handleAgentEvent("room1", "qa", "room1:qa", usageEvent({ inputTokens: 7 }), buffer, "rm_qa", undefined);

    const row = db.get<{ model: string; input_tokens: number }>(
      "SELECT model, input_tokens FROM token_usage_daily WHERE member_id = 'rm_qa'",
    );
    expect(row?.model).toBe("unknown");
    expect(row?.input_tokens).toBe(7);
  });

  it("still updates stats.json (no regression)", async () => {
    const { eh } = await loadModules();
    const buffer: any[] = [];
    eh.handleAgentEvent("room1", "dev", "room1:dev", usageEvent({ inputTokens: 30, outputTokens: 3, cost: 0.1 }), buffer, "rm_s", "prov/m");

    const statsPath = join(dir, "rooms", "room1", "agent-events", "rm_s.stats.json");
    const stats = JSON.parse(readFileSync(statsPath, "utf-8"));
    expect(stats.tokens.input).toBe(30);
    expect(stats.tokens.output).toBe(3);
    expect(stats.cost).toBeCloseTo(0.1);
  });

  it("does not throw when projection DB is unavailable (file-only mode)", async () => {
    const { eh } = await loadModules();
    // No initProjection call → getProjectionDb() is null; recordDailyUsage no-ops.
    const buffer: any[] = [];
    expect(() =>
      eh.handleAgentEvent("room1", "dev", "room1:dev", usageEvent({ inputTokens: 1 }), buffer, "rm_none", "prov/m"),
    ).not.toThrow();
    // Disk write still happened.
    const persisted = eh.loadEventsFromDisk("room1", "rm_none");
    expect(persisted.some((e: any) => e.type === "message_end")).toBe(true);
  });
});
