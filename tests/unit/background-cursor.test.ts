/**
 * Background execution context: history queries from a background child must
 * NOT advance the member's unread cursor (read-to-clear is a live-turn
 * behavior); the live path keeps it. Declarations unchanged; no model-facing
 * parameter controls this.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let tools: typeof import("../../src/engine/tools.js");
let roomStore: typeof import("../../src/workspace/room-store.js");
let registryMod: typeof import("../../src/workspace/member-registry.js");
let bus: typeof import("../../src/communication/message-bus.js");
let memberId = "";
let roomId = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bm-bgcursor-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  vi.resetModules();
  writeFileSync(join(dir, "agents", "general.md"), "---\nname: general\ndescription: general\nsystemPrompt: you are general\n---\ngeneral\n", "utf-8");

  tools = await import("../../src/engine/tools.js");
  roomStore = await import("../../src/workspace/room-store.js");
  registryMod = await import("../../src/workspace/member-registry.js");
  bus = await import("../../src/communication/message-bus.js");

  const member = registryMod.createMember({ name: "cursorbot", agentTemplate: "general", runtime: "pi-cli", model: "anthropic/model-x", credentialId: "cred-a" } as any);
  memberId = member.id;
  const room = roomStore.createRoom("cursor room", undefined, [{ agent: "general", name: "cursorbot" }]);
  roomStore.stampGlobalMemberIds(room.id, [memberId], memberId);
  roomId = room.id;
  // three room messages; cursor starts unset (all unread)
  bus.postMessage(roomId, "user", "first unread message");
  bus.postMessage(roomId, "user", "second unread message");
  bus.postMessage(roomId, "user", "third unread message");
});

afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function cursorOf(): string | null {
  return roomStore.getCursors(roomId)[memberId] ?? null;
}

describe("background history queries never consume unread positions", () => {
  it("a live read advances the member's cursor (read-to-clear kept)", async () => {
    const view = await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }) as any;
    expect(view?.ok ?? true).toBeTruthy();
    expect(cursorOf()).not.toBeNull();
  });

  it("a background read returns the same messages but leaves the cursor untouched", async () => {
    const before = cursorOf();
    const view = await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }, { execution: "background" }) as any;
    expect(view?.ok ?? true).toBeTruthy();
    expect(cursorOf()).toBe(before);
  });

  it("mixed sequence: background reads between live reads never regress or advance the cursor", async () => {
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 1 }); // live: advances
    const afterLive = cursorOf();
    expect(afterLive).not.toBeNull();
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }, { execution: "background" });
    expect(cursorOf()).toBe(afterLive); // unchanged by the background read
    bus.postMessage(roomId, "user", "fourth message arrives");
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }); // live: advances to the new latest
    expect(cursorOf()).not.toBe(afterLive);
  });
});
