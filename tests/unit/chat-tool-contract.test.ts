import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { createMember } from "../../src/app/member-actions.js";
import { createRoom, stampGlobalMemberIds } from "../../src/chat/conversations.js";
import { postMessage } from "../../src/chat/message-bus.js";
import { initRouter } from "../../src/chat/router.js";
import { ReplyObligationRepository } from "../../src/data/repositories/reply-obligation-repository.js";
import { handleToolCallback, loadScopeMessages } from "../../src/agent/tools/tools.js";
import { createBossmodeSdkTools } from "../../src/agent/runtime/tools.js";
import * as attachments from "../../src/agent/orchestrator/agent-attachments.js";

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

function setup(kind: "room" | "dm") {
  const sender = createMember({ name: "Sender" });
  const target = createMember({ name: "Target" });
  const room = createRoom("Chat contract", undefined, []);
  stampGlobalMemberIds(room.id, [sender.id, target.id]);
  const scope = kind === "dm" ? `dm:${sender.id}` : room.id;
  const chat = createBossmodeSdkTools({ roomId: scope, memberId: sender.id, scopeKind: kind === "dm" ? "dm" : "room" }).find(t => t.name === "chat_send")!;
  const call = (params: Record<string, unknown>) => handleToolCallback("chat_send", scope, sender.name, params, { memberId: sender.id });
  return { sender, target, scope, chat, call };
}

describe("chat_send tool contract", () => {
  // Replaces the removed parameter parsers' success/validation tests. No value
  // of an unknown field, even an empty one, is an accepted chat_send argument —
  // now including legacy names superseded by `to` / target resolution.
  it.each(["room", "dm"] as const)("%s rejects unknown fields before copying, posting, activation or debt settlement", async kind => {
    const { sender, target, scope, chat, call } = setup(kind);
    const ask = postMessage(scope, "user", "@Sender question", [sender.name]);
    await Promise.resolve(); // Do not count the prior user message as a tool activation.
    const source = join(fixture.root, "members", sender.id, "attachment.txt");
    writeFileSync(source, "must not be copied");
    const copy = vi.spyOn(attachments, "processAgentAttachments");
    const activate = vi.fn();
    const stop = initRouter({ mention: activate });
    const debts = new ReplyObligationRepository(fixture.db);
    const before = loadScopeMessages(scope);
    const rejected: Array<[string, unknown]> = [
      ...[undefined, null, true, [], [target.name], [target.id], [target.name, "unknown"]].map(value => ["need_response", value] as [string, unknown]),
      ...[undefined, null, "", `msg:#${ask.seq}`, "msg:2", "msg:#99", "msg:#abc", 42].map(value => ["reply_to", value] as [string, unknown]),
      ["target", "room"], ["extra", true], ["", true],
      ["needResponse", [target.name]], ["needResponseMemberIds", [target.id]],
      ["replyTo", { seq: ask.seq, messageId: ask.id }],
    ];
    try {
      for (const [key, value] of rejected) {
        const params = { message: "@Target must not send", attachments: [source], [key]: value };
        const error = `Unknown chat_send parameter: ${key}`;
        expect(await call(params)).toEqual({ ok: false, error });
        await expect((chat.execute as any)("rejected-chat", params)).rejects.toThrow(error);
        expect(loadScopeMessages(scope)).toEqual(before);
        expect(debts.listPending(scope, sender.id).map(debt => debt.messageId)).toEqual([ask.id]);
      }
      expect(copy).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
      expect(debts.listPending(scope, target.id)).toEqual([]);
    } finally { stop(); }
  });

  it.each(["room", "dm"] as const)("%s supported SDK chat settles own user debt and keeps member mentions FYI", async kind => {
    const { sender, target, scope, chat } = setup(kind);
    postMessage(scope, "user", "@Sender question", [sender.name]);
    const debts = new ReplyObligationRepository(fixture.db);
    expect(debts.listPending(scope, sender.id)).toHaveLength(1);
    await Promise.resolve();
    const activate = vi.fn();
    const stop = initRouter({ mention: activate });
    try {
      await (chat.execute as any)("own-answer", { message: "Target is a plain name" });
      expect(activate).not.toHaveBeenCalled();
      expect(debts.listPending(scope, sender.id)).toEqual([]);
      const result = await (chat.execute as any)("fyi-chat", { message: "@Target heads up", attachments: [] });
      const expected = kind === "dm" ? "Message sent to \"Direct message with user\"." : "Message sent to \"Chat contract\".";
      expect(result.content[0].text).toBe(expected);
      expect(loadScopeMessages(scope).at(-1)).toMatchObject({ sender: sender.name, senderMemberId: sender.id, content: "@Target heads up" });
      if (kind === "dm") expect(activate).not.toHaveBeenCalled();
      else {
        expect(activate).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledWith(scope, target.id, expect.objectContaining({ senderOrigin: "member" }));
        expect(loadScopeMessages(scope).at(-1)?.mentionMemberIds).toEqual([target.id]);
      }
      expect(debts.listPending(scope, target.id)).toEqual([]);
    } finally { stop(); }
  });

  it("resolves explicit targets by name, id and the user alias; foreign rooms are denied", async () => {
    const sender = createMember({ name: "Sender" });
    const other = createMember({ name: "Other" });
    const roomA = createRoom("Alpha room", undefined, []);
    stampGlobalMemberIds(roomA.id, [sender.id, other.id]);
    const roomB = createRoom("Beta room", undefined, []);
    stampGlobalMemberIds(roomB.id, [sender.id]);
    const roomC = createRoom("Gamma room", undefined, []);
    stampGlobalMemberIds(roomC.id, [other.id]);
    const call = (params: Record<string, unknown>) => handleToolCallback("chat_send", roomA.id, sender.name, params, { memberId: sender.id });

    // Room name (exact, case-insensitive) and scope-id literal.
    expect(await call({ to: "Beta room", message: "by name" })).toMatchObject({ ok: true });
    expect(loadScopeMessages(roomB.id).at(-1)).toMatchObject({ sender: sender.name, senderMemberId: sender.id, content: "by name" });
    expect(await call({ to: `room:${roomB.id}`, message: "by id" })).toMatchObject({ ok: true });
    expect(loadScopeMessages(roomB.id).at(-1)).toMatchObject({ content: "by id" });

    // "user" opens the caller's own private chat with the user.
    expect(await call({ to: "user", message: "hello user" })).toMatchObject({ ok: true });
    expect(loadScopeMessages(`dm:${sender.id}`).at(-1)).toMatchObject({ sender: sender.name, content: "hello user" });

    // Not a member → explicit error, nothing posted anywhere.
    const denied = await call({ to: `room:${roomC.id}`, message: "nope" }) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not a member/);

    const missing = await call({ to: "no such chat", message: "nope" }) as any;
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Chat not found/);
    expect(loadScopeMessages(roomA.id).some((m) => m.content === "nope")).toBe(false);
    expect(loadScopeMessages(roomB.id).some((m) => m.content === "nope")).toBe(false);
  });
});
