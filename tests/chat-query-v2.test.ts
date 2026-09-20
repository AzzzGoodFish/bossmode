import { afterEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { ensureDmScope, ensureMmScope, mmScopeIdOf, parseMmScopeId, storeRoom } from "../src/chat/conversations.js";
import { setUserReadCursor } from "../src/chat/cursors.js";
import {
  importMessage,
  countUserUnreadAndMention,
  readMessages,
  pageMessages,
  queryMessages,
  readConversationListState,
  searchMessages,
  type Message,
} from "../src/chat/messages.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function setup() {
  const fixture = coreFixture();
  fixtures.push(fixture);
  const scope = "room:rm_query";
  for (const [id, name] of [["mem_alpha", "Alpha"], ["mem_beta", "Beta"]]) fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    id, name, name.toLowerCase(), "general", "{}", 1, 1,
  );
  storeRoom({ id: "rm_query", name: "Query", memberIds: ["mem_alpha", "mem_beta"], createdAt: 1 }, fixture.db);
  const messages: Message[] = [
    { id: "m1", seq: 1, ts: 1_000, sender: "user", content: "first message", mentions: [] },
    { id: "m2", seq: 2, ts: 2_000, sender: "system", content: "hidden runtime notice", mentions: [] },
    {
      id: "m3", seq: 3, ts: 3_000, sender: "Alpha", senderMemberId: "mem_alpha",
      content: "reply @fish", mentions: ["fish"], replyTo: { seq: 1, messageId: "m1" },
      attachments: [{ id: "stored.txt", storedFilename: "stored.txt", originalFilename: "note.txt", previewType: "text" }],
    },
    { id: "m4", seq: 4, ts: 4_000, sender: "system", content: "knowledge changed", mentions: [], type: "knowledge_event" },
    { id: "m5", seq: 5, ts: 5_000, sender: "Beta", senderMemberId: "mem_beta", content: "near cursor", mentions: [] },
    { id: "m6", seq: 6, ts: 6_000, sender: "Beta", senderMemberId: "mem_beta", content: "hidden reply", mentions: [], replyTo: { seq: 2, messageId: "m2" } },
  ];
  for (const message of messages) importMessage(fixture.db, scope, message);
  return { fixture, scope };
}

describe("canonical member chat queries", () => {
  it("reads the nearest ascending window after a sequence and filters hidden notices before limiting", () => {
    const { fixture, scope } = setup();
    expect(queryMessages(scope, { fromSeq: 1, limit: 2 }, fixture.db).map(message => message.seq)).toEqual([3, 4]);
    expect(pageMessages(scope, { fromSeq: 1, limit: 2 }, fixture.db).map(message => message.seq)).toEqual([2, 3]);
  });

  it("anchors around a sequence and applies timestamp bounds", () => {
    const { fixture, scope } = setup();
    expect(queryMessages(scope, { aroundSeq: 4, limit: 3 }, fixture.db).map(message => message.seq)).toEqual([3, 4, 5]);
    expect(queryMessages(scope, { afterTs: 3_000, beforeTs: 6_000, limit: 10 }, fixture.db).map(message => message.seq)).toEqual([3, 4, 5]);
  });

  it("projects visible replies once and retains canonical attachment metadata", () => {
    const { fixture, scope } = setup();
    const rows = queryMessages(scope, { fromSeq: 0, limit: 10 }, fixture.db);
    expect(rows.find(message => message.id === "m3")).toMatchObject({
      replyTo: { seq: 1, messageId: "m1", sender: "user", excerpt: "first message" },
      attachments: [{ storedFilename: "stored.txt", originalFilename: "note.txt" }],
    });
    expect(rows.find(message => message.id === "m6")?.replyTo).toEqual({ seq: 2, messageId: "m2", unavailable: true });
    expect(rows.find(message => message.id === "m3")?.attachments?.[0]).not.toHaveProperty("path");
  });

  it("returns short search hits without expanding full-read reply or attachment views", () => {
    const { fixture, scope } = setup();
    const result = searchMessages(scope, { query: "reply" }, fixture.db);
    expect(result).toMatchObject({ total: 2 });
    expect(result.messages.map(message => message.seq)).toEqual([6, 3]);
    expect(result.messages.find(message => message.id === "m3")).toEqual({
      id: "m3", seq: 3, sender: "Alpha", senderMemberId: "mem_alpha", content: "reply @fish", ts: 3_000,
    });
    expect(result.messages.find(message => message.id === "m3")).not.toHaveProperty("replyTo");
    expect(result.messages.find(message => message.id === "m3")).not.toHaveProperty("attachments");
    expect(searchMessages(scope, { query: "runtime" }, fixture.db)).toEqual({ total: 0, messages: [] });
  });
});

describe("conversation list read model", () => {
  it("matches legacy mixed-sequence cursor semantics without hydrating history", () => {
    const { fixture, scope } = setup();
    importMessage(fixture.db, scope, { id: "unsequenced", ts: 7000, sender: "Alpha", content: "legacy @Fish", mentions: [] });
    const messages = readMessages(scope, fixture.db);
    const all = vi.spyOn(fixture.db, "all");
    for (const [messageId, seq] of [[null, null], ["m3", null], ["gone", null], ["m1", 3], [null, 6], [null, 99]] as const) {
      setUserReadCursor(scope, { messageId, seq }, fixture.db);
      for (const login of ["fish", "Fish", ""]) {
        expect(readConversationListState(scope, login, fixture.db)).toMatchObject(countUserUnreadAndMention(messages, messageId, seq, login));
      }
    }
    expect(all).not.toHaveBeenCalled();
    all.mockRestore();
  });

  it("uses one ordered canonical member-private scope and rejects malformed pairs", () => {
    expect(mmScopeIdOf("mem_beta", "mem_alpha")).toBe("mm:mem_alpha-mem_beta");
    expect(parseMmScopeId("mm:mem_alpha-mem_beta")).toEqual(["mem_alpha", "mem_beta"]);
    expect(parseMmScopeId("mm:mem_beta-mem_alpha")).toBeNull();
    expect(parseMmScopeId("mm:mem_alpha-mem_alpha")).toBeNull();
    expect(parseMmScopeId("mm:not-a-pair")).toBeNull();
    expect(() => mmScopeIdOf("mem_alpha", "mem_alpha")).toThrow();
  });

  it("applies the same list semantics to room, DM and member-private scopes", () => {
    const { fixture, scope } = setup();
    const dm = ensureDmScope("mem_alpha", fixture.db);
    const mm = ensureMmScope("mem_alpha", "mem_beta", fixture.db);
    for (const [index, target] of [dm, mm].entries()) importMessage(fixture.db, target, {
      id: `private-${index}`, seq: 1, ts: 10_000 + index, sender: "Alpha", senderMemberId: "mem_alpha",
      content: "hello @fish", mentions: ["fish"],
    });
    expect(readConversationListState(scope, "fish", fixture.db)).toMatchObject({ unreadCount: 3, mentioned: true });
    for (const target of [dm, mm]) expect(readConversationListState(target, "fish", fixture.db)).toMatchObject({
      unreadCount: 1, mentioned: true, lastMessage: { sender: "Alpha", text: "hello @fish" },
    });
  });

  it("owns cursor windowing, unread eligibility, mention detection and last-message projection", () => {
    const { fixture, scope } = setup();
    setUserReadCursor(scope, { messageId: "m1", seq: 1 }, fixture.db, 7_000);
    expect(readConversationListState(scope, "fish", fixture.db)).toEqual({
      lastMessage: { sender: "Beta", senderMemberId: "mem_beta", text: "hidden reply", ts: 6_000 },
      unreadCount: 3,
      mentioned: true,
    });
  });
});
