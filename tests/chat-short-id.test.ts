/**
 * Chat short ids (unified user prompt spec v1.6): rooms keep rm_<id>, user DMs
 * derive dm_<member suffix>, member-to-member scopes mint dm_<random> once.
 * resolveChatScope must accept short ids and legacy refs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { ensureDmScope, ensureMmScope, chatShortId, resolveChatScope, backfillScopeShortIds, storeRoom } from "../src/chat/conversations.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  for (const [id, name] of [["mem_ab12cd34ef", "M"], ["mem_zzz0000001", "Z"], ["mem_aaa1111111", "A"]]) fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id, name, name.toLowerCase(), "general", "{}", 1, 1,
  );
  return fixture;
}

describe("chat short ids", () => {
  it("room scope keeps its rm_ id and resolves back", () => {
    const fixture = setup();
    storeRoom({ id: "rm_testroom01", name: "Test", members: [], globalMemberIds: [], createdAt: 1 }, fixture.db);
    expect(chatShortId("room:rm_testroom01", fixture.db)).toBe("rm_testroom01");
    expect(resolveChatScope("rm_testroom01", fixture.db)).toBe("room:rm_testroom01");
    expect(resolveChatScope("room:rm_testroom01", fixture.db)).toBe("room:rm_testroom01");
  });

  it("user DM derives dm_<member suffix> and resolves back", () => {
    const fixture = setup();
    const scope = ensureDmScope("mem_ab12cd34ef", fixture.db);
    expect(scope).toBe("dm:mem_ab12cd34ef");
    expect(chatShortId(scope, fixture.db)).toBe("dm_ab12cd34ef");
    expect(resolveChatScope("dm_ab12cd34ef", fixture.db)).toBe("dm:mem_ab12cd34ef");
    expect(resolveChatScope("dm:mem_ab12cd34ef", fixture.db)).toBe("dm:mem_ab12cd34ef");
  });

  it("mm scope mints a stable dm_ short id exactly once", () => {
    const fixture = setup();
    const scope = ensureMmScope("mem_zzz0000001", "mem_aaa1111111", fixture.db);
    const short = chatShortId(scope, fixture.db);
    expect(short).toMatch(/^dm_[A-Za-z0-9]{10}$/);
    expect(chatShortId(scope, fixture.db)).toBe(short);
    expect(resolveChatScope(short, fixture.db)).toBe(scope);
  });

  it("backfill fills legacy rows without short ids, idempotently", () => {
    const fixture = setup();
    fixture.db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES ('mm:mem_old0000001-mem_old0000002','mm',NULL,'mem_old0000001|mem_old0000002')");
    fixture.db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES ('dm:mem_legacydm01','dm',NULL,'mem_legacydm01')");
    const filled = backfillScopeShortIds(fixture.db);
    expect(filled).toBe(2);
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM scopes WHERE short_id IS NULL")!.n).toBe(0);
    expect(backfillScopeShortIds(fixture.db)).toBe(0);
    expect(chatShortId("dm:mem_legacydm01", fixture.db)).toBe("dm_legacydm01");
    expect(resolveChatScope("dm_legacydm01", fixture.db)).toBe("dm:mem_legacydm01");
  });

  it("unknown references do not resolve", () => {
    const fixture = setup();
    expect(resolveChatScope("dm_nosuch9999", fixture.db)).toBeNull();
    expect(resolveChatScope("nonsense", fixture.db)).toBeNull();
  });
});
