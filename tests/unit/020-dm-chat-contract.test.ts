/**
 * 0.20 DM chat contract — member replies in DM scope persist as RoomMessage
 * shape (content + sender = member name snapshot) AND broadcast to dm:<id>
 * subscribers. Regression guard for the DmPage contract mismatch (rc.1–rc.3
 * rendered msg.text / sender === "member", both wrong).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

const broadcastToRoom = vi.fn();

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return { ...actual, broadcastToRoom: (...args: unknown[]) => broadcastToRoom(...args) };
});

function seedAgent(name: string) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: \"${name}\"\n---\n\nYou are ${name}.\n`,
    "utf-8",
  );
}

describe("020 DM chat contract", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-dm-chat-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("architect");
    broadcastToRoom.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat in dm scope persists RoomMessage shape and broadcasts to dm:<id>", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const dmRoomId = `dm:${member.id}`;

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const result = (await handleToolCallback("response", dmRoomId, "architect", { message: "hello dm" })) as any;
    expect(result.ok).toBe(true);

    const store = await import("../../src/workspace/dm-message-store.js");
    const messages = store.readAllDmMessages(member.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("architect");
    expect(messages[0].content).toBe("hello dm");
    expect(typeof messages[0].id).toBe("string");
    expect(typeof messages[0].ts).toBe("number");

    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    const [targetRoom, event] = broadcastToRoom.mock.calls[0] as any[];
    expect(targetRoom).toBe(dmRoomId);
    expect(event.type).toBe("room:message");
    expect(event.roomId).toBe(dmRoomId);
    expect(event.message.content).toBe("hello dm");
    expect(event.message.sender).toBe("architect");
  });
});
