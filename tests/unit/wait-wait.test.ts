import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ tmpDir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.tmpDir,
}));

import {
  waitForMember,
  notifyMemberIdle,
  settleWaitOnAbort,
  clearAllWaitsForTests,
  isMemberWaiting,
  WAIT_DEFAULT_TIMEOUT_MIN,
} from "../../src/engine/wait-wait.js";
import { postMessage } from "../../src/communication/message-bus.js";

beforeEach(() => {
  state.tmpDir = mkdtempSync(join(tmpdir(), "bossmode-wait-"));
  mkdirSync(join(state.tmpDir, "rooms", "room-a"), { recursive: true });
  clearAllWaitsForTests();
});

afterEach(() => {
  clearAllWaitsForTests();
  rmSync(state.tmpDir, { recursive: true, force: true });
});

describe("waitForMember", () => {
  it("returns immediately when target is already idle", async () => {
    const outcome = await waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "idle",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("idle");
      expect(outcome.detail).toMatch(/already idle/i);
    }
  });

  it("rejects self-wait and concurrent second wait", async () => {
    const self = await waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_pm",
      targetName: "pm",
      targetStatus: "working",
    });
    expect(self.ok).toBe(false);

    const first = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(isMemberWaiting("room-a", "rm_pm")).toBe(true);

    const second = await waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_dev",
      targetName: "developer",
      targetStatus: "working",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/one wait/i);

    settleWaitOnAbort("room-a", "rm_pm");
    await first;
  });

  it("resolves when target posts an agent-authored message", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));

    postMessage("room-a", "qa", "QA report ready", [], { senderMemberId: "rm_qa" });

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("message");
      expect(outcome.message).toBe("QA report ready");
    }
  });

  it("ignores user/system messages without senderMemberId; settles on idle", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));

    postMessage("room-a", "user", "hello");
    postMessage("room-a", "system", "noise");
    expect(isMemberWaiting("room-a", "rm_pm")).toBe(true);

    notifyMemberIdle("room-a", "rm_qa");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("idle");
  });

  it("resolves on target idle notification", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    notifyMemberIdle("room-a", "rm_qa");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("idle");
  });

  it("resolves on @mention of the waiter (mention_interrupt)", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));

    postMessage("room-a", "user", "@pm please look", ["pm"], {
      mentionMemberIds: ["rm_pm"],
    });

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("mention_interrupt");
  });

  it("resolves on abort settle", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "rm_pm",
      waiterName: "pm",
      targetMemberId: "rm_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    settleWaitOnAbort("room-a", "rm_pm");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("mention_interrupt");
  });

  it("times out", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForMember({
        roomId: "room-a",
        waiterMemberId: "rm_pm",
        waiterName: "pm",
        targetMemberId: "rm_qa",
        targetName: "qa",
        targetStatus: "working",
        timeoutMinutes: 1,
      });
      await vi.advanceTimersByTimeAsync(60_000 + 50);
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.reason).toBe("timeout");
        expect(outcome.detail).toMatch(/Timed out/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports default timeout constant", () => {
    expect(WAIT_DEFAULT_TIMEOUT_MIN).toBe(30);
  });
});
