import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { storeRoom } from "../src/chat/conversations.js";
import { appendMessageWithAdmissions, confirmChatAdmission } from "../src/chat/delivery.js";
import { getMemberCursor } from "../src/chat/cursors.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  for (const [id, name] of [["mem_one", "One"], ["mem_two", "Two"]]) fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id, name, name.toLowerCase(), "general", "{}", 1, 1,
  );
  storeRoom({ id: "rm_test", name: "Test", members: [], globalMemberIds: ["mem_one", "mem_two"], createdAt: 1 }, fixture.db);
  return fixture;
}
function enqueue(fixture: ReturnType<typeof coreFixture>, admission: ReturnType<typeof appendMessageWithAdmissions>["admissions"][number]): number {
  const row = fixture.db.get<{id:number}>(`INSERT INTO queued_inputs(member_id,idempotency_key,source_ref,payload_json,trigger,reply_expected,placement,status,created_at)
    VALUES(?,?,?,?,?,?,?,'pending',?) RETURNING id`, admission.memberId, admission.idempotencyKey, admission.sourceRef,
  JSON.stringify(admission.input), admission.input.trigger, Number(admission.replyExpected), "tail", Date.now())!;
  return row.id;
}

describe("chat delivery v2", () => {
  it("captures room input, queue receipt and cursor atomically", () => {
    const fixture = setup();
    const result = fixture.db.transaction((tx) => {
      const prepared = appendMessageWithAdmissions(tx, "room:rm_test", {
        sender: "user", content: "@One hello", mentions: ["One"], mentionMemberIds: ["mem_one"], needResponseMemberIds: ["mem_one"],
      });
      expect(prepared.admissions).toHaveLength(1);
      const id = enqueue(fixture, prepared.admissions[0]);
      const confirmation = confirmChatAdmission(tx, prepared.admissions[0].chatToken, id, prepared.message.ts + 1);
      return { ...prepared, id, confirmation };
    });
    expect(result.confirmation).toEqual({ confirmed: true, cursorConfirmed: true });
    expect(result.admissions[0].input.prompt).toContain("[REPLY EXPECTED]");
    expect(result.admissions[0].input.prompt).toContain("@One hello");
    expect(getMemberCursor("room:rm_test", "mem_one", fixture.db)).toBe(result.message.id);
    expect(confirmChatAdmission(fixture.db, result.admissions[0].chatToken, result.id)).toEqual({ confirmed: false, cursorConfirmed: false });
    expect(fixture.db.get<{status:string}>("SELECT status FROM chat_admissions")!.status).toBe("confirmed");
  });

  it("rolls message, capture, admission, queue and cursor back together", () => {
    const fixture = setup();
    expect(() => fixture.db.transaction((tx) => {
      const prepared = appendMessageWithAdmissions(tx, "room:rm_test", {
        sender: "user", content: "@One fail", mentions: ["One"], mentionMemberIds: ["mem_one"],
      });
      enqueue(fixture, prepared.admissions[0]);
      throw new Error("fail admission");
    })).toThrow("fail admission");
    for (const table of ["messages", "delivery_captures", "captured_deliveries", "chat_admissions", "queued_inputs"]) {
      expect(fixture.db.get<{n:number}>(`SELECT COUNT(*) n FROM ${table}`)!.n, table).toBe(0);
    }
    expect(getMemberCursor("room:rm_test", "mem_one", fixture.db)).toBeNull();
  });
});
