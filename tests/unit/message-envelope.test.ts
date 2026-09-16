
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { writeConfig } from "../../src/config/settings.js";
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  writeConfig({ auth: { username: "fish", passwordHash: "" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } });
});
afterEach(() => fixture.close());

import {
  chatRefOf,
  resolveSenderRole,
  wrapRoomContextMessage,
  wrapRoomMessagesTranscript,
  type ChatLabel,
} from "../../src/agent/orchestrator/message-envelope.js";
import type { RoomMessage } from "../../src/kernel/types.js";

function makeMsg(sender: string, content: string, seq?: number, ts?: number, senderMemberId?: string): RoomMessage {
  return {
    id: `msg-${sender}`,
    sender,
    content,
    mentions: [],
    ts: ts ?? Date.now(),
    ...(seq !== undefined ? { seq } : {}),
    ...(senderMemberId !== undefined ? { senderMemberId } : {}),
  };
}

const FIXED_TS = new Date("2026-07-17T14:32:00").getTime();
const ROOM: ChatLabel = { kind: "room", id: "room-1", name: "bossmode dev" };

describe("message envelope wrappers", () => {
  it("wrapRoomContextMessage formats user sender with display name, seq, timestamp and the source chat id", () => {
    const msg = makeMsg("user", "hello", 10235, FIXED_TS);
    expect(wrapRoomContextMessage(msg, ROOM, "user")).toBe(
      "[Message from room \"bossmode dev\" (room:room-1). User `fish`, No.10235, 07-17 14:32]\n\nhello",
    );
  });

  it("wrapRoomContextMessage marks the sender's member id (① D1)", () => {
    const msg = makeMsg("architect", "sync done", 7, FIXED_TS, "mem_arch");
    expect(wrapRoomContextMessage(msg, ROOM, "member")).toBe(
      "[Message from room \"bossmode dev\" (room:room-1). Member `architect` (mem_arch), No.7, 07-17 14:32]\n\nsync done",
    );
  });

  it("wrapRoomContextMessage omits No. when seq is absent (legacy unmigrated message)", () => {
    const msg = makeMsg("user", "hello", undefined, FIXED_TS);
    expect(wrapRoomContextMessage(msg, ROOM, "user")).toBe(
      "[Message from room \"bossmode dev\" (room:room-1). User `fish`, 07-17 14:32]\n\nhello",
    );
  });

  it("labels a private chat with dm:<memberId>", () => {
    const dm: ChatLabel = { kind: "dm", id: "mem_me", name: "Direct message with user" };
    const msg = makeMsg("user", "hi", 3, FIXED_TS);
    expect(chatRefOf(dm)).toBe("dm:mem_me");
    expect(wrapRoomContextMessage(msg, dm, "user")).toContain("[Message from room \"Direct message with user\" (dm:mem_me).");
  });

  it("wrapRoomMessagesTranscript formats multiple messages with a shared header and per-message sub-headers", () => {
    const messages = [
      { msg: makeMsg("user", "message B", 10236, FIXED_TS), role: "user" as const },
      { msg: makeMsg("qa", "message C", 10237, FIXED_TS, "mem_qa"), role: "member" as const },
    ];
    expect(wrapRoomMessagesTranscript(messages, ROOM)).toBe(
      "[Messages from room \"bossmode dev\" (room:room-1)]\n\n[User `fish`, No.10236, 07-17 14:32]\n\nmessage B\n\n\n[Member `qa` (mem_qa), No.10237, 07-17 14:32]\n\nmessage C",
    );
  });

  it("escapes quotes in room and sender labels", () => {
    const msg = makeMsg('dev"ops', "quoted", 1, FIXED_TS);
    const chat: ChatLabel = { kind: "room", id: "room-1", name: 'boss"mode' };
    expect(wrapRoomContextMessage(msg, chat, "member")).toContain('room "boss\\"mode"');
    expect(wrapRoomContextMessage(msg, chat, "member")).toContain('`dev\\"ops`');
  });

  it("supports empty content", () => {
    const msg = makeMsg("user", "", 1, FIXED_TS);
    expect(wrapRoomContextMessage(msg, ROOM, "user")).toBe(
      "[Message from room \"bossmode dev\" (room:room-1). User `fish`, No.1, 07-17 14:32]\n\n",
    );
  });

  it("resolveSenderRole maps user vs others", () => {
    expect(resolveSenderRole("user")).toBe("user");
    expect(resolveSenderRole("pm")).toBe("member");
    expect(resolveSenderRole("system")).toBe("member");
  });
});
