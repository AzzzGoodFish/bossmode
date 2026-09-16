import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ username: "" as string | undefined, throwOnRead: false }));

vi.mock("../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config.js")>();
  return {
    ...actual,
    readConfig: () => {
      if (state.throwOnRead) throw new Error("Config not found");
      return { auth: { username: state.username ?? "", passwordHash: "" }, apiKeys: {}, defaults: {} };
    },
  };
});

import { getUserDisplayName } from "../../src/config/user-identity.js";
import { wrapRoomContextMessage } from "../../src/agent/orchestrator/message-envelope.js";
import type { RoomMessage } from "../../src/kernel/types.js";

const FIXED_TS = new Date("2026-07-17T14:32:00").getTime();

function userMsg(content = "hello"): RoomMessage {
  return { id: "msg-user", sender: "user", content, mentions: [], ts: FIXED_TS, seq: 1 };
}

describe("getUserDisplayName", () => {
  it("follows auth username", () => {
    state.username = "lhy";
    state.throwOnRead = false;
    expect(getUserDisplayName()).toBe("lhy");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `lhy`");
  });

  it("falls back to User when username is empty", () => {
    state.username = "";
    state.throwOnRead = false;
    expect(getUserDisplayName()).toBe("User");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `User`");
  });

  it("falls back to User when config is missing", () => {
    state.throwOnRead = true;
    expect(getUserDisplayName()).toBe("User");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `User`");
  });

  it("trims whitespace", () => {
    state.username = "  lhy  ";
    state.throwOnRead = false;
    expect(getUserDisplayName()).toBe("lhy");
  });
});
