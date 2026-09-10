import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

import { coreFixture } from "../helpers/core-fixture.js";
import { saveAgentDefinition } from "../../src/workforce/agent-store.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => { fixture = coreFixture(); dir = fixture.root; });
afterEach(() => fixture.close());
function writeAgent(name: string): void {
  saveAgentDefinition(name, `---\nname: ${name}\nmodel: anthropic/${name}\n---\n${name} prompt\n`);
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
    const room = roomStore.createRoom("A", dir, [{ agent: "developer", name: "dev-a" }]);

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
