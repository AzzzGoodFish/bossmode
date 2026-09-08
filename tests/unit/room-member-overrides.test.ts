import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

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

function writeAgent(name: string): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\nmodel: anthropic/${name}\n---\n${name} prompt\n`, "utf-8");
}

describe("room member overrides", () => {
  it("keeps model and thinking overrides scoped to one room", async () => {
    writeAgent("pm");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const roomA = roomStore.createRoom("A", dir, drafts(["pm"]));
    const roomB = roomStore.createRoom("B", dir, drafts(["pm"]));

    roomStore.updateRoomMemberOverride(roomA.id, "pm", {
      model: "anthropic/room-a",
      credentialId: "cred-a",
      thinkingLevel: "high",
    });

    expect(resolveRoomMember(roomA.id, "pm")).toMatchObject({ model: "anthropic/room-a", credentialId: "cred-a", thinkingLevel: "high" });
    expect(resolveRoomMember(roomB.id, "pm")).toMatchObject({ model: undefined, credentialId: undefined, thinkingLevel: "off" });

    roomStore.updateRoomMemberOverride(roomA.id, "pm", { model: null, thinkingLevel: null });
    expect(resolveRoomMember(roomA.id, "pm")).toMatchObject({ model: undefined, thinkingLevel: "off" });
    expect(roomStore.hasRoomMemberModelOverride(roomA.id, "pm")).toBe(false);
  });

  it("does not fallback to a legacy global member or the Agent definition for direct Agent-created members", async () => {
    writeAgent("developer");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    writeFileSync(join(dir, "members.json"), JSON.stringify([
      { id: "legacy-dev", name: "dev-a", agent: "qa", runtime: "pi-cli", model: "anthropic/legacy", thinkingLevel: "high" },
    ]));
    const room = roomStore.createRoom("A", dir, drafts([]));
    const added = roomStore.addRoomMemberFromAgent(room.id, { agentName: "developer", memberName: "dev-a" });
    expect(added.ok).toBe(true);

    expect(resolveRoomMember(room.id, "dev-a")).toMatchObject({
      id: expect.stringMatching(/^rm_/),
      name: "dev-a",
      agent: "developer",
      model: undefined,
      credentialId: undefined,
      thinkingLevel: "off",
    });
  });
});
