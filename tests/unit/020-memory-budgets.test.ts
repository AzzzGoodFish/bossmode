/**
 * Memory budget configuration (0.20 experience ①, fish 2026-08-05).
 * Single source of truth: SQL app_settings budgets → getMemoryBudget used by
 * compile, write validation, and panel percentage. Semantics preserved:
 * defaults = 4000/4000/4000/8000 (pre-config behavior); lowering never
 * truncates existing content; a write is rejected until trimmed.
 */
import { coreFixture } from "../helpers/core-fixture.js";
import { SettingsRepository } from "../../src/storage/repositories/settings.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  new SettingsRepository(fixture.db).importConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } });
  new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] });
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

function setConfig(config: { memoryBudgets?: Record<string, number> }) {
  new SettingsRepository(fixture.db).importConfig({ ...getDefaultConfig(), ...config });
}

describe("memory budgets", () => {
  it("defaults when config is absent or has no memoryBudgets section", async () => {
    fixture.db.run("DELETE FROM app_settings");
    const budgets = await import("../../src/workspace/memory-budgets.js");
    expect(budgets.getMemoryBudgets()).toEqual({ persona: 4000, memberPrinciples: 4000, mainline: 4000, roomPrinciples: 8000 });
    setConfig({});
    expect(budgets.getMemoryBudgets()).toEqual({ persona: 4000, memberPrinciples: 4000, mainline: 4000, roomPrinciples: 8000 });
  });

  it("reads configured values; invalid values fall back per-key", async () => {
    setConfig({
      memoryBudgets: { persona: 6000, mainline: 9000, roomPrinciples: 0, garbage: -5 },
    });
    const budgets = await import("../../src/workspace/memory-budgets.js");
    expect(budgets.getMemoryBudget("persona")).toBe(6000);
    expect(budgets.getMemoryBudget("memberPrinciples")).toBe(4000);
    expect(budgets.getMemoryBudget("mainline")).toBe(9000);
    expect(budgets.getMemoryBudget("roomPrinciples")).toBe(8000); // 0 → fallback
  });

  it("write validation uses the configured budget (member mainline + principles)", async () => {
    setConfig({ memoryBudgets: { mainline: 50, memberPrinciples: 60, roomPrinciples: 80 } });
    const memStore = await import("../../src/workspace/member-memory-store.js");
    const actor = { type: "member" as const, memberId: "mem_1", name: "qa" };
    // 60 chars of member principles at 60 budget: exactly at limit passes.
    memStore.writeMemoryLayer("mem_1", "principles", "x".repeat(60), actor, { scopeId: "room:room-a", reason: "test", operation: "write" });
    // Over budget rejected.
    expect(() => memStore.writeMemoryLayer("mem_1", "principles", "x".repeat(61), actor, { scopeId: "room:room-a", reason: "test", operation: "write" }))
      .toThrow(/exceed its budget/);
    // Mainline over 50 rejected.
    expect(() => memStore.writeMemoryLayer("mem_1", "mainline", "x".repeat(51), actor, { scopeId: "room:room-a", reason: "test", operation: "write" }))
      .toThrow(/exceed its budget/);
  });

  it("legacy mainline store write validation uses the configured budget", async () => {
    setConfig({ memoryBudgets: { mainline: 30 } });
    const mainlineStore = await import("../../src/workspace/mainline-store.js");
    const actor = { type: "member" as const, memberId: "mem_1", name: "qa" };
    mainlineStore.writeMainline({ roomId: "room-a", memberId: "rm_qa", content: "x".repeat(30), actor, reason: "test" });
    expect(() => mainlineStore.writeMainline({ roomId: "room-a", memberId: "rm_qa", content: "x".repeat(31), actor, reason: "test" })).toThrow(/exceed its budget/);
  });

  it("room principles budget uses the configured value; member principles separate", async () => {
    setConfig({ memoryBudgets: { memberPrinciples: 100, roomPrinciples: 200 } });
    const principlesStore = await import("../../src/workspace/principles-store.js");
    expect(principlesStore.principlesBudgetLimit("member")).toBe(100);
    expect(principlesStore.principlesBudgetLimit("room")).toBe(200);
  });

  it("normalizeMemoryBudgetsInput validates partial updates and preserves others", async () => {
    setConfig({ memoryBudgets: { mainline: 5000 } });
    const budgets = await import("../../src/workspace/memory-budgets.js");
    const next = budgets.normalizeMemoryBudgetsInput({ persona: 3000 });
    expect(next.persona).toBe(3000);
    expect(next.mainline).toBe(5000);
    expect(next.roomPrinciples).toBe(8000);
    expect(() => budgets.normalizeMemoryBudgetsInput({ persona: 0 })).toThrow(/positive/);
    expect(() => budgets.normalizeMemoryBudgetsInput({ mainline: -3 })).toThrow(/positive/);
  });

  it("lowering a budget below existing content does NOT truncate the file (rejected on next write)", async () => {
    setConfig({});
    const memStore = await import("../../src/workspace/member-memory-store.js");
    const actor = { type: "member" as const, memberId: "mem_1", name: "qa" };
    memStore.writeMemoryLayer("mem_1", "principles", "x".repeat(3000), actor, { scopeId: "room:room-a", reason: "test", operation: "write" });
    const before = memStore.readMemoryLayer("mem_1", "principles", "room:room-a");
    expect(before.content.length).toBe(3000);

    // Lower budget below existing content.
    setConfig({ memoryBudgets: { memberPrinciples: 1000 } });
    const memStore2 = await import("../../src/workspace/member-memory-store.js");
    // Existing content stays (no truncation) — budget header shows over-limit.
    const after = memStore2.readMemoryLayer("mem_1", "principles", "room:room-a");
    expect(after.content).toBe(before.content);
    expect(after.meta.budget).toMatchObject({ usage: 3000, limit: 1000, overLimit: true, pct: 300 });
    fixture.reopen();
    expect(memStore2.readMemoryLayer("mem_1", "principles", "room:room-a")).toEqual(after);
    expect(memStore2.readMemoryLayerInfo("mem_1", "principles", "room:room-a").revision).toBe(1);
    // Next write over the new budget is rejected.
    const actor2 = { type: "member" as const, memberId: "mem_1", name: "qa" };
    expect(() => memStore2.writeMemoryLayer("mem_1", "principles", "x".repeat(1001), actor2, { scopeId: "room:room-a", reason: "test", operation: "write" })).toThrow(/exceed its budget/);
    expect(memStore2.readMemoryLayerInfo("mem_1", "principles", "room:room-a")).toMatchObject({ content: before.content, revision: 1 });
  });
});
