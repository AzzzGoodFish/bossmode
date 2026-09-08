import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let dir: string;
vi.mock("../../src/shared/config.js", () => ({ getBossmodeDir: () => dir }));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bossmode-runtime-db-")); vi.resetModules(); });
afterEach(async () => {
  const { resetDbCache } = await import("../../src/workspace/db/sqlite.js"); resetDbCache();
  rmSync(dir, { recursive: true, force: true });
});
describe("member runtime comes from the supported runtime, not retired JSON", () => {
  it.each([false, true])("uses pi-cli for a DB member with retired storage present=%s", async (withOldStore) => {
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const member = createMember({ name: "dev", runtime: "claude-cli" } as any);
    if (withOldStore) writeFileSync(join(dir, "members.json"), JSON.stringify([{ id: member.id, name: member.name, runtime: "claude-cli", model: "stale" }]));
    const room = join(dir, "rooms", "room-a"); mkdirSync(room, { recursive: true });
    writeFileSync(join(room, "room.json"), JSON.stringify({ id: "room-a", name: "room-a", globalMemberIds: [member.id], createdAt: 1 }));
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember("room-a", member.id)).toMatchObject({ id: member.id, runtime: "pi-cli" });
    expect(resolveRoomMember("room-a", member.id)?.model).not.toBe("stale");
    expect(existsSync(join(dir, "members.json"))).toBe(withOldStore);
  });
});
