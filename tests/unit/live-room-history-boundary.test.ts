import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { getRoom, importLegacyRoom, storeRoom } from "../../src/chat/conversations.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { fixture.close(); });

describe("live room and historical metadata boundary", () => {
  it("keeps imported rule docs in history tables without exposing or rewriting them in live rooms", () => {
    importLegacyRoom({
      id: "legacy-room", name: "Legacy", createdAt: 1, globalMemberIds: [],
      ruleDocs: ["rules/a.md", "rules/b.md"],
    }, fixture.db);

    const live = getRoom("legacy-room", fixture.db)!;
    expect(live).not.toHaveProperty("ruleDocs");
    storeRoom({ ...live, name: "Renamed" }, fixture.db);

    expect(fixture.db.all("SELECT path FROM room_rule_docs WHERE room_id=? ORDER BY position", "legacy-room"))
      .toEqual([{ path: "rules/a.md" }, { path: "rules/b.md" }]);
    expect(fixture.db.get<{ has_rule_docs: number }>("SELECT has_rule_docs FROM rooms WHERE id=?", "legacy-room")!.has_rule_docs).toBe(1);
  });

  it("does not create historical rule-doc state from live room writes", () => {
    storeRoom({ id: "live-room", name: "Live", memberIds: [], createdAt: 1 }, fixture.db);
    expect(fixture.db.get<{ has_rule_docs: number }>("SELECT has_rule_docs FROM rooms WHERE id=?", "live-room")!.has_rule_docs).toBe(0);
    expect(fixture.db.get("SELECT 1 FROM room_rule_docs WHERE room_id=?", "live-room")).toBeUndefined();
  });
});
