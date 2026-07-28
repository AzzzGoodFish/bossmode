import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let roomId = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-watch-tool-"));
  mkdirSync(join(tmpDir, "agents"), { recursive: true });
  for (const agent of ["pm", "qa"]) {
    writeFileSync(join(tmpDir, "agents", `${agent}.md`), `---\nname: ${agent}\n---\n${agent}`, "utf8");
  }
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("watch-tool-room", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });
  roomId = room.id;
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("watch tool — execution gate + actions", () => {
  it("leader can subscribe/list/unsubscribe; names resolve; expiry is ~7 days", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const sub = await handleToolCallback("watch", roomId, "pm", { action: "subscribe", member: "qa" }) as any;
    expect(sub.ok).toBe(true);
    expect(sub.watch.target).toBe("qa");
    expect(sub.watch.expiresAt - sub.watch.createdAt).toBe(7 * 24 * 3600_000);

    const list = await handleToolCallback("watch", roomId, "pm", { action: "list" }) as any;
    expect(list.ok).toBe(true);
    expect(list.watches).toHaveLength(1);
    expect(list.watches[0].target).toBe("qa");

    const removed = await handleToolCallback("watch", roomId, "pm", { action: "unsubscribe", member: "qa" }) as any;
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    const empty = await handleToolCallback("watch", roomId, "pm", { action: "list" }) as any;
    expect(empty.watches).toHaveLength(0);
  });

  it("re-subscribing replaces (still one watch)", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    await handleToolCallback("watch", roomId, "pm", { action: "subscribe", member: "qa" });
    await handleToolCallback("watch", roomId, "pm", { action: "subscribe", member: "qa" });
    const list = await handleToolCallback("watch", roomId, "pm", { action: "list" }) as any;
    expect(list.watches).toHaveLength(1);
  });

  it("non-leader is rejected at execution (second door)", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const denied = await handleToolCallback("watch", roomId, "qa", { action: "subscribe", member: "pm" }) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Only the configured room leader/);
    const deniedList = await handleToolCallback("watch", roomId, "qa", { action: "list" }) as any;
    expect(deniedList.ok).toBe(false);
  });

  it("self-watch and unknown member are rejected", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const self = await handleToolCallback("watch", roomId, "pm", { action: "subscribe", member: "pm" }) as any;
    expect(self.ok).toBe(false);
    expect(self.error).toMatch(/Cannot watch yourself/);
    const ghost = await handleToolCallback("watch", roomId, "pm", { action: "subscribe", member: "nobody" }) as any;
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toMatch(/Member not found/);
  });

  it("bad action is rejected", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const bad = await handleToolCallback("watch", roomId, "pm", { action: "peek" }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/action must be/);
  });

  it("room without a configured leader: watch unavailable", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const plain = roomStore.createRoom("no-leader-room", tmpDir, drafts(["pm", "qa"]));
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const res = await handleToolCallback("watch", plain.id, "pm", { action: "list" }) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No room leader/);
  });
});

describe("watch tool — assembly gate", () => {
  it("leader sees the watch tool; non-leader does not", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const leaderTools = createBossmodeSdkTools({ roomId, agentName: "pm", roomMembers: ["pm", "qa"] });
    const memberTools = createBossmodeSdkTools({ roomId, agentName: "qa", roomMembers: ["pm", "qa"] });
    expect(leaderTools.some((t) => t.name === "watch")).toBe(true);
    expect(memberTools.some((t) => t.name === "watch")).toBe(false);
  });
});
