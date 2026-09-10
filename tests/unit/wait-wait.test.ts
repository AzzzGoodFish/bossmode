import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { importMemberRecord } from "../../src/workspace/member-registry.js";
let fixture: ReturnType<typeof coreFixture>;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  fixture = coreFixture();
  for (const name of ["pm", "qa", "dev"]) importMemberRecord({
    id: `mem_${name}`, name, agentTemplate: "general", unifiedModel: true, unifiedExtensions: true,
    global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
    scopeOverrides: {}, createdAt: 1, updatedAt: 1,
  });
  new ConversationsRepository().upsertRoom({ id: "room-a", name: "Wait", members: ["pm", "qa", "dev"],
    globalMemberIds: ["mem_pm", "mem_qa", "mem_dev"], createdAt: 1 });
  clearAllWaitsForTests();
});

afterEach(() => {
  clearAllWaitsForTests();
  fixture.close();
});

describe("waitForMember", () => {
  it("returns immediately when target is already idle", async () => {
    const outcome = await waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
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
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_pm",
      targetName: "pm",
      targetStatus: "working",
    });
    expect(self.ok).toBe(false);

    const first = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(true);

    const second = await waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_dev",
      targetName: "developer",
      targetStatus: "working",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/one wait/i);

    settleWaitOnAbort("room-a", "mem_pm");
    await first;
  });

  it("resolves when target posts an agent-authored message", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));

    postMessage("room-a", "qa", "QA report ready", [], { senderMemberId: "mem_qa" });

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
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));

    postMessage("room-a", "user", "hello");
    postMessage("room-a", "system", "noise");
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(true);

    notifyMemberIdle("room-a", "mem_qa");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("idle");
  });

  it("resolves on target idle notification", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    notifyMemberIdle("room-a", "mem_qa");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("idle");
  });

  it("resolves with reason error when target idles after turn failure", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    notifyMemberIdle("room-a", "mem_qa", { error: "request failed. Error: terminated" });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("error");
      expect(outcome.detail).toMatch(/terminated/i);
      expect(outcome.detail).toMatch(/No output produced/i);
      expect(outcome.detail).toMatch(/verify status/i);
    }
  });

  it("does not wake on idle notify for a different member (transient retry stays working)", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Other member idling / error must not settle this wait — target still working (retry).
    notifyMemberIdle("room-a", "mem_dev", { error: "terminated" });
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(true);
    notifyMemberIdle("room-a", "mem_qa");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("idle");
  });

  it("resolves on @mention of the waiter (mention_interrupt) after one tick — no abort", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(true);

    postMessage("room-a", "user", "@pm please look", ["pm"], {
      mentionMemberIds: ["mem_pm"],
    });

    // Steer-first: still waiting on the same tick as the message (deferred settle).
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(true);

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.reason).toBe("mention_interrupt");
      expect(outcome.message).toBeUndefined(); // body is NOT on wait result
      expect(outcome.detail).toMatch(/mentioned by user/i);
    }
    expect(isMemberWaiting("room-a", "mem_pm")).toBe(false);
  });

  it("mention path never calls abortAgent (steer owns delivery)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/engine/wait-wait.ts"), "utf8");
    expect(src).not.toMatch(/import\(.*agent-manager/);
    expect(src).not.toMatch(/\.abortAgent\s*\(/);
    expect(src).toMatch(/setTimeout/);
    const tools = readFileSync(resolve(process.cwd(), "src/engine/tools.ts"), "utf8");
    // wait case must not abort after mention_interrupt
    expect(tools).not.toMatch(/mention_interrupt[\s\S]{0,120}abortAgent/);
  });

  it("resolves on abort settle", async () => {
    const pending = waitForMember({
      roomId: "room-a",
      waiterMemberId: "mem_pm",
      waiterName: "pm",
      targetMemberId: "mem_qa",
      targetName: "qa",
      targetStatus: "working",
      timeoutMinutes: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    settleWaitOnAbort("room-a", "mem_pm");
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.reason).toBe("mention_interrupt");
  });

  it("times out", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForMember({
        roomId: "room-a",
        waiterMemberId: "mem_pm",
        waiterName: "pm",
        targetMemberId: "mem_qa",
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
