import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { appendAgentEvent, importAgentEvent } from "../../src/data/repositories/event-repository.js";
import { getMemberTokenUsage, getRoomMemberTokenUsage } from "../../src/workspace/token-usage-store.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";

let fixture: ReturnType<typeof coreFixture>;
const member = { ownerKey: "mem_dev", memberId: "mem_dev" };
beforeEach(() => {
  fixture = coreFixture();
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_dev','developer','developer','general','{}',1,1)");
  for (const id of ["room-a", "room-b"]) new ConversationsRepository().upsertRoom({ id, name: id, members: ["developer"], globalMemberIds: ["mem_dev"], createdAt: 1 });
  fixture.db.run("INSERT INTO scopes VALUES('dm:mem_dev','dm',NULL,'mem_dev'),('topic:a','topic','room-a',NULL)");
});
afterEach(() => { fixture.close(); });
describe("stable member token summaries", () => {
  it("sums all token dimensions across rooms, DM and topic without double-counting a proven event ID", () => {
    appendAgentEvent("room-a", member, { type: "message_end", usage: { inputTokens: 10, outputTokens: 5, cacheRead: 3, cacheWrite: 2 } }, "a1");
    appendAgentEvent("room-a", member, { type: "message_start" });
    appendAgentEvent("room-a", member, { type: "message_end", usage: { inputTokens: 7, outputTokens: 8 } });
    appendAgentEvent("room-b", member, { type: "message_end", usage: { inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheWrite: 4 } });
    appendAgentEvent("room-b", member, { type: "message_end" });
    expect(getMemberTokenUsage(member.memberId)).toEqual({ totalTokens: 45 });
    appendAgentEvent("room-a", member, { type: "message_end", usage: { inputTokens: 10, outputTokens: 5, cacheRead: 3, cacheWrite: 2 } }, "a1");
    for (const scope of ["dm:mem_dev", "topic:a"]) {
      appendAgentEvent(scope, member, { type: "message_end", usage: { inputTokens: 5 } });
      appendAgentEvent(scope, { ownerKey: "mem_other", memberId: "mem_other" }, { type: "message_end", usage: { inputTokens: 900 } });
    }
    fixture.db.run("UPDATE members SET name='renamed',name_key='renamed' WHERE id='mem_dev'");
    fixture.reopen();
    expect(getMemberTokenUsage(member.memberId)).toEqual({ totalTokens: 55 });
    fixture.db.run("UPDATE members SET archived_at=2,archive_path='backups/fired-dev' WHERE id='mem_dev'");
    expect(getMemberTokenUsage(member.memberId)).toEqual({ totalTokens: 55 });
  });
  it("reads only the requested room by stable ID or its current roster label", () => {
    appendAgentEvent("room-a", member, { type: "message_end", usage: { inputTokens: 4, outputTokens: 6 } });
    appendAgentEvent("room-b", member, { type: "message_end", usage: { inputTokens: 100 } });
    expect(getRoomMemberTokenUsage("room-a", member.memberId)).toEqual({ totalTokens: 10 });
    expect(getRoomMemberTokenUsage("room-a", "developer")).toEqual({ totalTokens: 10 });
    expect(getRoomMemberTokenUsage("room-a", "absent")).toEqual({ totalTokens: 0 });
  });
  it("never attributes unresolved historical labels or ID-shaped filenames to a current member", () => {
    for (const ownerKey of ["legacy-unresolved:developer", "legacy-unresolved:mem_dev"]) importAgentEvent(fixture.db, { id: ownerKey, scopeId: "room-a", ownerKey, memberId: null, seq: 1, ts: 1, event: { type: "message_end", usage: { inputTokens: 999 } } });
    expect(getMemberTokenUsage("mem_dev")).toEqual({ totalTokens: 0 });
  });
  it("counts only positive finite token values, never cost as tokens", () => {
    appendAgentEvent("room-a", member, { type: "message_end", usage: { inputTokens: -4, outputTokens: 6, cacheRead: 0, cacheWrite: 2, cost: 900 } });
    expect(getMemberTokenUsage("mem_dev")).toEqual({ totalTokens: 8 });
  });
});
