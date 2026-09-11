import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { createMember } from "../../src/workspace/member-registry.js";
import { createRoom, stampGlobalMemberIds } from "../../src/workspace/room-store.js";
import { createTopic } from "../../src/workspace/topic-store.js";
import { postMessage } from "../../src/communication/message-bus.js";
import { initRouter } from "../../src/communication/router.js";
import { ReplyObligationRepository } from "../../src/storage/repositories/reply-obligation-repository.js";
import { handleToolCallback, loadScopeMessages } from "../../src/engine/tools.js";
import { createBossmodeSdkTools } from "../../src/engine/runtime/bossmode-sdk-tools.js";
import * as attachments from "../../src/engine/agent-attachments.js";

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

function setup(kind: "room" | "dm" | "topic") {
  const sender = createMember({ name: "Sender" });
  const target = createMember({ name: "Target" });
  const room = createRoom("Chat contract", undefined, []);
  stampGlobalMemberIds(room.id, [sender.id, target.id]);
  const topic = createTopic({ roomId: room.id, title: "Chat contract", anchorMessageId: "anchor", seedMode: "fresh" });
  const scope = kind === "dm" ? `dm:${sender.id}` : kind === "topic" ? `topic:${topic.id}` : room.id;
  const chat = createBossmodeSdkTools({ roomId: scope, memberId: sender.id, scopeKind: kind === "dm" ? "dm" : "room" }).find(t => t.name === "chat")!;
  const call = (params: Record<string, unknown>) => handleToolCallback("chat", scope, sender.name, params, { memberId: sender.id });
  return { sender, target, scope, chat, call };
}

describe("chat tool contract", () => {
  // Replaces the removed parameter parsers' success/validation tests. No value
  // of an unknown field, even an empty one, is an accepted chat argument.
  it.each(["room", "dm", "topic"] as const)("%s rejects unknown fields before copying, posting, activation or debt settlement", async kind => {
    const { sender, target, scope, chat, call } = setup(kind);
    const ask = postMessage(scope, "user", "@Sender question", [sender.name]);
    await Promise.resolve(); // Do not count the prior user message as a tool activation.
    const source = join(fixture.root, "members", sender.id, "attachment.txt");
    writeFileSync(source, "must not be copied");
    const copy = vi.spyOn(attachments, "processAgentAttachments");
    const activate = vi.fn();
    const stop = initRouter({ mention: activate, urgent: activate });
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
        const error = `Unknown chat parameter: ${key}`;
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

  it.each(["room", "dm", "topic"] as const)("%s supported SDK chat settles own user debt and keeps member mentions FYI", async kind => {
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
      expect(result.content[0].text).toBe("Message sent to room.");
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
});
