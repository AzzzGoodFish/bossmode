import { getDefaultConfig, writeConfig } from "../../src/config/settings.js";
import { coreFixture } from "../helpers/core-fixture.js";


import { storeRoom } from "../../src/chat/conversations.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  writeConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } }, fixture.db);
  storeRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] }, fixture.db);
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

describe("room-store updateRuleDocPathsByPrefix", () => {
  it("updates matching ruleDocs prefix and deduplicates", async () => {
    const { createRoom, getRoom, updateRuleDocPathsByPrefix } = await import("../../src/chat/conversations.js");

    const room = createRoom("r1", "/tmp", [], [
      "bossmode/rules/a.md",
      "bossmode/rules/sub/b.md",
      "other/rules/x.md",
      "bossmode-new/rules/a.md",
    ]);

    const affected = updateRuleDocPathsByPrefix("bossmode/rules", "bossmode-new/rules");
    expect(affected).toBe(1);

    fixture.reopen();
    const updated = getRoom(room.id);
    expect(updated?.ruleDocs).toEqual([
      "bossmode-new/rules/a.md",
      "bossmode-new/rules/sub/b.md",
      "other/rules/x.md",
    ]);
  });

  it("does not affect rooms without matching prefix", async () => {
    const { createRoom, updateRuleDocPathsByPrefix } = await import("../../src/chat/conversations.js");
    createRoom("r1", "/tmp", [], ["foo/bar.md"]);
    expect(updateRuleDocPathsByPrefix("bossmode/rules", "bossmode2/rules")).toBe(0);
  });

  it("matches exact folders and slash boundaries, ignores empty prefixes and unrelated rooms", async () => {
    const { createRoom, getRoom, updateRuleDocPathsByPrefix } = await import("../../src/chat/conversations.js");
    const room = createRoom("bounds", undefined, [], ["rules", "rules/a.md", "rules-other/a.md"]);
    const empty = createRoom("empty", undefined, []);
    expect(updateRuleDocPathsByPrefix("", "new")).toBe(0);
    expect(updateRuleDocPathsByPrefix("rules", "")).toBe(0);
    expect(updateRuleDocPathsByPrefix("rules", "new")).toBe(1);
    fixture.reopen();
    expect(getRoom(room.id)?.ruleDocs).toEqual(["new", "new/a.md", "rules-other/a.md"]);
    expect(getRoom(empty.id)?.ruleDocs).toBeUndefined();
    expect(updateRuleDocPathsByPrefix("rules", "new")).toBe(0);
  });
});
