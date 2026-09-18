import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig, getUserDisplayName, writeConfig } from "../../src/config/settings.js";
import { coreFixture } from "../helpers/core-fixture.js";
import { wrapRoomContextMessage } from "../../src/agent/prompt.js";
import type { RoomMessage } from "../../src/kernel/types.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => fixture.close());
function setUsername(username: string): void {
  writeConfig({ ...getDefaultConfig(), auth: { username, passwordHash: "fixture-only" } });
}
function userMsg(content = "hello"): RoomMessage {
  return { id: "msg-user", sender: "user", content, mentions: [], ts: Date.parse("2026-07-17T14:32:00Z"), seq: 1 };
}

describe("getUserDisplayName", () => {
  it("follows the stored login name in the actual message envelope", () => {
    setUsername("lhy");
    expect(getUserDisplayName()).toBe("lhy");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `lhy`");
  });
  it("falls back to User when username is empty", () => {
    setUsername("");
    expect(getUserDisplayName()).toBe("User");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `User`");
  });
  it("falls back to User when configuration is not initialized", () => {
    expect(getUserDisplayName()).toBe("User");
    expect(wrapRoomContextMessage(userMsg(), "room", "user")).toContain("User `User`");
  });
  it("trims whitespace", () => {
    setUsername("  lhy  ");
    expect(getUserDisplayName()).toBe("lhy");
  });
});
