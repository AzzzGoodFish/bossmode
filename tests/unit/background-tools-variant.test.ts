/**
 * Background execution variant of the bossmode SDK tool factory:
 * identical declarations/schemas, execution-layer rejection for scope-posting
 * and background-start tools; everything else still routes through the
 * dispatcher.
 */
import { describe, expect, it, vi } from "vitest";

const calls: Array<{ tool: string; params: Record<string, any> }> = [];

vi.mock("../../src/engine/tools.js", () => ({
  handleToolCallback: vi.fn(async (tool: string, _roomId: string, _agentName: string, params: Record<string, any>) => {
    calls.push({ tool, params });
    return { ok: true, note: `dispatched:${tool}` };
  }),
}));

import { handleToolCallback } from "../../src/engine/tools.js";
import { createBossmodeSdkTools } from "../../src/engine/runtime/bossmode-sdk-tools.js";

const COMMON = { roomId: "room:bgroom", memberId: "mem-bgagent", agentName: "bgagent", roomMembers: ["bgagent", "other"] };

describe("createBossmodeSdkTools execution=background", () => {
  const live = createBossmodeSdkTools(COMMON);
  const background = createBossmodeSdkTools({ ...COMMON, execution: "background" });

  it("permits self profile updates in background with trusted member context", async () => {
    const tool = background.find((t) => t.name === "update_profile")!;
    await (tool.execute as any)("id", { title: "New title" });
    expect(handleToolCallback).toHaveBeenLastCalledWith("update_profile", COMMON.roomId, COMMON.memberId, { title: "New title" }, { memberId: COMMON.memberId, execution: "background" });
  });

  it("keeps tool declarations identical between live and background variants", () => {
    const shape = (tools: ReturnType<typeof createBossmodeSdkTools>) =>
      tools.map((t) => ({ name: t.name, label: t.label, parameters: t.parameters }));
    expect(shape(background)).toEqual(shape(live));
  });

  it("rejects chat and member-wait execution inside a background session with an explicit error", async () => {
    for (const name of ["chat", "wait"]) {
      const tool = background.find((t) => t.name === name)!;
      await expect(
        (tool.execute as any)?.("id", name === "chat" ? { message: "hello" } : { member: "other" }),
      ).rejects.toThrow(/not available inside a background task/);
    }
    expect(calls.find((c) => c.tool === "chat" || c.tool === "wait")).toBeUndefined();
  });

  it("rejects background-start family tools inside a background session", async () => {
    for (const name of ["background_start", "recall", "memorize"]) {
      const tool = background.find((t) => t.name === name);
      if (!tool) continue; // not yet registered — guard is name-based
      await expect(
        (tool.execute as any)?.("id", {}),
      ).rejects.toThrow(/not available inside a background task/);
    }
  });

  it("still dispatches non-forbidden tools from a background session", async () => {
    calls.length = 0;
    const tool = background.find((t) => t.name === "query_room_messages")!;
    await (tool.execute as any)?.("id", { query: "x" });
    expect(calls).toContainEqual({ tool: "query_room_messages", params: { query: "x" } });
  });

  it("live variant still dispatches chat and wait", async () => {
    calls.length = 0;
    const tool = live.find((t) => t.name === "chat")!;
    await (tool.execute as any)?.("id", { message: "hi" });
    expect(calls.find((c) => c.tool === "chat")).toBeDefined();
    const waitTool = live.find((t) => t.name === "wait");
    if (waitTool) {
      await (waitTool.execute as any)?.("id", { member: "other" });
      expect(calls.find((c) => c.tool === "wait")).toBeDefined();
    }
  });
});
