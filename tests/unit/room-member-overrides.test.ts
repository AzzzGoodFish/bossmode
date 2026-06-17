import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bossmode-room-member-overrides-"));
  vi.resetModules();
  vi.stubEnv("BOSSMODE_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("room member overrides", () => {
  it("keeps model and thinking overrides scoped to one room", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { saveMember, getMemberByName } = await import("../../src/workforce/member-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    saveMember({ name: "pm", agent: "pm", runtime: "pi-cli", model: "anthropic/global", thinkingLevel: "off" });
    const roomA = roomStore.createRoom("A", dir, ["pm"]);
    const roomB = roomStore.createRoom("B", dir, ["pm"]);

    roomStore.updateRoomMemberOverride(roomA.id, "pm", {
      model: "anthropic/room-a",
      credentialId: "cred-a",
      thinkingLevel: "high",
    });

    expect(resolveRoomMember(roomA.id, "pm")).toMatchObject({ model: "anthropic/room-a", credentialId: "cred-a", thinkingLevel: "high" });
    expect(resolveRoomMember(roomB.id, "pm")).toMatchObject({ model: "anthropic/global", thinkingLevel: "off" });
    expect(getMemberByName("pm")).toMatchObject({ model: "anthropic/global", thinkingLevel: "off" });

    roomStore.updateRoomMemberOverride(roomA.id, "pm", { model: null, thinkingLevel: null });
    expect(resolveRoomMember(roomA.id, "pm")).toMatchObject({ model: "anthropic/global", thinkingLevel: "off" });
    expect(roomStore.hasRoomMemberModelOverride(roomA.id, "pm")).toBe(false);
  });
});
