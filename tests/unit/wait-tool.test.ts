import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;

let roomId = "";

beforeEach(async () => {
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
  const { createMember } = await import("../../src/workspace/member-registry.js");
  const members = ["pm", "qa", "developer"].map(name => createMember({ name }));
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("wait-tool-room", undefined, []);
  roomStore.stampGlobalMemberIds(room.id, members.map(m => m.id), members[0].id);
  roomId = room.id;
});

afterEach(async () => {
  const { clearAllWaitsForTests } = await import("../../src/engine/wait-wait.js");
  clearAllWaitsForTests();
  vi.resetModules();
  fixture.close();
});

describe("wait tool — gates + idle short-circuit", () => {
  it("leader wait rejects missing, unknown and self targets", async () => {
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

  it("0.20: non-leader can also wait (no longer leader-only)", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const { notifyMemberIdle, isMemberWaiting } = await import("../../src/engine/wait-wait.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const qa = roomStore.getRoomMembers(roomId).find((m) => m.name === "qa")!;
    const developer = roomStore.getRoomMembers(roomId).find((m) => m.name === "developer")!;

    const pending = handleToolCallback("wait", roomId, "qa", { member: "developer", timeoutMinutes: 5 });
    await vi.waitFor(() => expect(isMemberWaiting(roomId, qa.id)).toBe(true), { timeout: 5000 });
    notifyMemberIdle(roomId, developer.id);
    const result = await pending as any;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("idle");
  });

  it("assembly gate: all room members see wait; watch is gone", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const { getRoomMembers } = await import("../../src/workspace/room-store.js");
    const members = getRoomMembers(roomId);
    const leaderTools = createBossmodeSdkTools({ memberId: members.find(m => m.name === "pm")!.id, roomId });
    const memberTools = createBossmodeSdkTools({ memberId: members.find(m => m.name === "qa")!.id, roomId });
    expect(leaderTools.some((t) => t.name === "wait")).toBe(true);
    expect(leaderTools.some((t) => t.name === "watch")).toBe(false);
    expect(memberTools.some((t) => t.name === "wait")).toBe(true);
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
    await vi.waitFor(() => expect(isMemberWaiting(roomId, pm.id)).toBe(true), { timeout: 5000 });
    notifyMemberIdle(roomId, qa.id);
    const result = await pending as any;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("idle");
  });

  it("@ while waiting → mention_interrupt via tool path, no abort side-effect", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const { isMemberWaiting } = await import("../../src/engine/wait-wait.js");
    const { postMessage } = await import("../../src/communication/message-bus.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const pm = roomStore.getRoomMembers(roomId).find((m) => m.name === "pm")!;

    const pending = handleToolCallback("wait", roomId, "pm", { member: "qa", timeoutMinutes: 5 });
    await vi.waitFor(() => expect(isMemberWaiting(roomId, pm.id)).toBe(true), { timeout: 5000 });

    postMessage(roomId, "user", "@pm please continue", ["pm"], {
      mentionMemberIds: [pm.id],
    });

    const result = await pending as any;
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("mention_interrupt");
    expect(result.message).toBeUndefined();
    expect(result.detail).toMatch(/mentioned/i);
  });
});
