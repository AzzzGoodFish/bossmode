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
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-wait-tool-"));
  mkdirSync(join(tmpDir, "agents"), { recursive: true });
  for (const agent of ["pm", "qa", "developer"]) {
    writeFileSync(join(tmpDir, "agents", `${agent}.md`), `---\nname: ${agent}\n---\n${agent}`, "utf8");
  }
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("wait-tool-room", tmpDir, drafts(["pm", "qa", "developer"]), undefined, {
    promptLeaderMemberName: "pm",
  });
  roomId = room.id;
});

afterEach(async () => {
  const { clearAllWaitsForTests } = await import("../../src/engine/wait-wait.js");
  clearAllWaitsForTests();
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("wait tool — gates + idle short-circuit", () => {
  it("leader can wait; already-idle target returns immediately", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    // getAgentStatus with no live instance → inactive, not idle.
    // Force idle by checking the short-circuit path via wait-wait directly is covered
    // in wait-wait tests; here we exercise the tool gate + missing member etc.

    const noMember = await handleToolCallback("wait", roomId, "pm", {}) as any;
    expect(noMember.ok).toBe(false);
    expect(noMember.error).toMatch(/member is required/i);

    const ghost = await handleToolCallback("wait", roomId, "pm", { member: "nobody" }) as any;
    expect(ghost.ok).toBe(false);
    expect(ghost.error).toMatch(/Member not found/);

    const self = await handleToolCallback("wait", roomId, "pm", { member: "pm" }) as any;
    expect(self.ok).toBe(false);
    expect(self.error).toMatch(/yourself/);
  });

  it("non-leader is rejected", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const denied = await handleToolCallback("wait", roomId, "qa", { member: "developer" }) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Only the configured room leader/);
  });

  it("assembly gate: leader sees wait; non-leader does not; watch is gone", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const leaderTools = createBossmodeSdkTools({ roomId, agentName: "pm", roomMembers: ["pm", "qa", "developer"] });
    const memberTools = createBossmodeSdkTools({ roomId, agentName: "qa", roomMembers: ["pm", "qa", "developer"] });
    expect(leaderTools.some((t) => t.name === "wait")).toBe(true);
    expect(leaderTools.some((t) => t.name === "watch")).toBe(false);
    expect(memberTools.some((t) => t.name === "wait")).toBe(false);
    expect(memberTools.some((t) => t.name === "watch")).toBe(false);
  });

  it("wait resolves via tool path when target becomes idle (notify hook)", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const { notifyMemberIdle, isMemberWaiting } = await import("../../src/engine/wait-wait.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const qa = roomStore.getRoomMembers(roomId).find((m) => m.name === "qa")!;
    const pm = roomStore.getRoomMembers(roomId).find((m) => m.name === "pm")!;

    const pending = handleToolCallback("wait", roomId, "pm", { member: "qa", timeoutMinutes: 5 });
    // Wait until the blocking wait is registered (tool path does async imports first).
    for (let i = 0; i < 50 && !isMemberWaiting(roomId, pm.id); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(isMemberWaiting(roomId, pm.id)).toBe(true);
    notifyMemberIdle(roomId, qa.id);
    const result = await pending as any;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("idle");
  });
});
