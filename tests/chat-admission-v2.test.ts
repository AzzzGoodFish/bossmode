import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { assertMemberScopeAccess, ensureDmScope, ensureMmScope, storeRoom } from "../src/chat/conversations.js";
import { appendMessageWithAdmissions, confirmChatAdmission, listPendingChatAdmissions, repairPendingChatAdmission } from "../src/chat/delivery.js";
import { getMemberCursor } from "../src/chat/cursors.js";
import { scheduleMessageDispatch, setMessageSink } from "../src/chat/messages.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { setMessageSink(undefined); for (const fixture of fixtures.splice(0)) fixture.close(); });
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
    expect(result.admissions[0].input.prompt).toContain('<chat_message chat_name="Test" chat_id="rm_test" chat_type="channel" sender_id="user" sender_name="user" msg_id="1"');
    expect(result.admissions[0].input.prompt).not.toContain("REPLY EXPECTED");
    expect(result.admissions[0].input.prompt).toContain("@One hello");
    expect(getMemberCursor("room:rm_test", "mem_one", fixture.db)).toBe(result.message.id);
    expect(confirmChatAdmission(fixture.db, result.admissions[0].chatToken, result.id)).toEqual({ confirmed: false, cursorConfirmed: false });
    expect(fixture.db.get<{status:string}>("SELECT status FROM chat_admissions")!.status).toBe("confirmed");
  });

  it("dispatches a committed message from the durable outbox with a canonical source", async () => {
    const fixture = setup();
    const delivered: Array<{ sourceRef: string; id: string }> = [];
    setMessageSink((sourceRef, message) => delivered.push({ sourceRef, id: message.id }));
    const result = appendMessageWithAdmissions(fixture.db, "room:rm_test", {
      sender: "system", content: "committed", mentions: [],
    });
    scheduleMessageDispatch();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered).toEqual([{ sourceRef: "room:rm_test", id: result.message.id }]);
    expect(fixture.db.get<{ delivered_at: number | null }>("SELECT delivered_at FROM outbox")!.delivered_at).not.toBeNull();
  });

  it("repairs only explicit pending admission and never confirmed work", () => {
    const fixture = setup();
    const pending = appendMessageWithAdmissions(fixture.db, "room:rm_test", {
      sender: "user", content: "@One pending", mentions: ["One"], mentionMemberIds: ["mem_one"],
    });
    expect(listPendingChatAdmissions(fixture.db)).toEqual(pending.admissions);
    const repaired = repairPendingChatAdmission(fixture.db, "room:rm_test", pending.message.id, "mem_one");
    expect(repaired).toEqual(pending.admissions[0]);
    const inputId = enqueue(fixture, repaired!);
    confirmChatAdmission(fixture.db, repaired!.chatToken, inputId);
    expect(repairPendingChatAdmission(fixture.db, "room:rm_test", pending.message.id, "mem_one")).toBeNull();
    expect(listPendingChatAdmissions(fixture.db)).toEqual([]);
  });

  it("prepares DM and member-chat inputs without room unread context", () => {
    const fixture = setup();
    ensureDmScope("mem_one", fixture.db);
    ensureMmScope("mem_one", "mem_two", fixture.db);
    const dm = appendMessageWithAdmissions(fixture.db, "dm:mem_one", {
      sender: "user", content: "private user", mentions: [],
    });
    expect(dm.admissions).toHaveLength(1);
    expect(dm.admissions[0].memberId).toBe("mem_one");
    expect(dm.admissions[0].chatToken.cursor?.scopeId).toBe("dm:mem_one");
    expect(dm.admissions[0].input.prompt).toContain('chat_name="user"');
    expect(dm.admissions[0].input.prompt).toContain('chat_type="dm"');

    const mm = appendMessageWithAdmissions(fixture.db, "mm:mem_one-mem_two", {
      sender: "One", senderMemberId: "mem_one", content: "private member", mentions: [],
    });
    expect(mm.admissions).toHaveLength(1);
    expect(mm.admissions[0].memberId).toBe("mem_two");
    expect(mm.admissions[0].chatToken.cursor?.scopeId).toBe("mm:mem_one-mem_two");
    expect(mm.admissions[0].input.prompt).toContain('chat_name="One"');
    expect(mm.admissions[0].input.prompt).toContain('sender_id="mem_one"');
    expect(assertMemberScopeAccess("mem_one", "mm:mem_one-mem_two").kind).toBe("mm");
    expect(() => assertMemberScopeAccess("mem_one", "dm:mem_two")).toThrow("own DM");
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
