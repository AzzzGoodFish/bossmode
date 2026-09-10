import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { createMember, updateMember } from "../../src/workspace/member-registry.js";

import { coreFixture } from "../helpers/core-fixture.js";
import { importHistoricalAgentTemplate } from "../helpers/historical-agent-template.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => { fixture = coreFixture(); dir = fixture.root; });
afterEach(() => fixture.close());
function writeAgent(name: string): void {
  importHistoricalAgentTemplate(fixture, name, `---\nname: ${name}\nmodel: anthropic/${name}\n---\n${name} prompt\n`);
}
function historicalRoom(id: string, name: string, sourceAgent: string) {
  const room = { id, name: id, createdAt: 1, members: [name], roomMembers: [
    { id: `rm_${id}`, roomId: id, name, sourceAgent, createdAt: 1, updatedAt: 1 },
  ] };
  new ConversationsRepository(fixture.db).upsertRoom(room);
  return room;
}

describe("room member overrides", () => {
  it("retains historical model and thinking overrides scoped to one room without runtime admission", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const roomA = historicalRoom("A", "pm", "pm");
    const roomB = historicalRoom("B", "pm", "pm");

    roomStore.updateRoomMemberOverride(roomA.id, "pm", {
      model: "anthropic/room-a",
      credentialId: "cred-a",
      thinkingLevel: "high",
    });

    expect(roomStore.getRoomMemberOverride(roomA.id, "pm")).toMatchObject({ model: "anthropic/room-a", credentialId: "cred-a", thinkingLevel: "high" });
    expect(roomStore.getRoomMemberOverride(roomB.id, "pm")).toBeUndefined();
    expect(resolveRoomMember(roomA.id, "pm")).toBeNull();
    expect(resolveRoomMember(roomB.id, "pm")).toBeNull();

    roomStore.updateRoomMemberOverride(roomA.id, "pm", { model: null, thinkingLevel: null });
    expect(roomStore.getRoomMemberOverride(roomA.id, "pm")).toBeUndefined();
    expect(roomStore.hasRoomMemberModelOverride(roomA.id, "pm")).toBe(false);
  });

  it("does not resolve an unlinked historical snapshot through same-named contacts, legacy files or template metadata", async () => {
    writeAgent("developer");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    writeFileSync(join(dir, "members.json"), JSON.stringify([
      { id: "legacy-dev", name: "dev-a", agent: "qa", runtime: "pi-cli", model: "anthropic/legacy", thinkingLevel: "high" },
    ]));
    const unrelated = createMember({ name: "dev-a", model: "current/model", credentialId: "current-cred" });
    const room = historicalRoom("A", "dev-a", "developer");

    expect(resolveRoomMember(room.id, "dev-a")).toBeNull();
    expect(roomStore.getRoomMembers(room.id)[0]).toMatchObject({ id: "rm_A", name: unrelated.name, sourceAgent: "developer" });
  });
});

it("current contact settings apply globally and never become room-local overrides", async () => {
  const rooms = await import("../../src/workspace/room-store.js");
  const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
  const member = createMember({ name: "current" });
  const a = rooms.createRoom("A", undefined, [member.id]);
  const b = rooms.createRoom("B", undefined, [member.id]);
  updateMember(member.id, { global: { model: "current/model", credentialId: "cred", thinkingLevel: "high" } });
  for (const room of [a, b]) {
    expect(resolveRoomMember(room.id, member.id)).toMatchObject({ model: "current/model", credentialId: "cred", thinkingLevel: "high" });
    expect(rooms.getRoomMemberOverride(room.id, member.name)).toBeUndefined();
    expect(rooms.hasRoomMemberModelOverride(room.id, member.name)).toBe(false);
  }
});
