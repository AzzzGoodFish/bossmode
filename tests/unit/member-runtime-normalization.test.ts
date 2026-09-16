import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => { fixture = coreFixture(); dir = fixture.root; });
afterEach(() => fixture.close());
describe("member runtime comes from the supported runtime, not retired JSON", () => {
  it.each([false, true])("uses pi-cli for a DB member with retired storage present=%s", async (withOldStore) => {
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const member = createMember({ name: "dev", runtime: "claude-cli" } as any);
    if (withOldStore) writeFileSync(join(dir, "members.json"), JSON.stringify([{ id: member.id, name: member.name, runtime: "claude-cli", model: "stale" }]));
    const room = join(dir, "rooms", "room-a"); mkdirSync(room, { recursive: true });
    new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "room-a", members: [], globalMemberIds: [member.id], createdAt: 1 });
    writeFileSync(join(room, "room.json"), "poison retired room");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember("room-a", member.id)).toMatchObject({ id: member.id, runtime: "pi-cli" });
    expect(resolveRoomMember("room-a", member.id)?.model).not.toBe("stale");
    expect(existsSync(join(dir, "members.json"))).toBe(withOldStore);
  });
});
