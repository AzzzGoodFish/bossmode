import { describe, expect, it } from "vitest";
import {
  resolveSenderRole,
  wrapRoomContextMessage,
  wrapRoomMessagesTranscript,
} from "../../src/engine/message-envelope.js";
import type { RoomMessage } from "../../src/shared/types.js";

function makeMsg(sender: string, content: string, seq?: number, ts?: number): RoomMessage {
  return {
    id: `msg-${sender}`,
    sender,
    content,
    mentions: [],
    ts: ts ?? Date.now(),
    ...(seq !== undefined ? { seq } : {}),
  };
}

const FIXED_TS = new Date("2026-07-17T14:32:00").getTime();

describe("message envelope wrappers", () => {
  it("wrapRoomContextMessage formats user sender with display name, seq, and timestamp", () => {
    const msg = makeMsg("user", "hello", 10235, FIXED_TS);
    expect(wrapRoomContextMessage(msg, "bossmode dev", "user")).toBe(
      "[Message from room \"bossmode dev\". User `fish`, No.10235, 07-17 14:32]\n\nhello",
    );
  });

  it("wrapRoomContextMessage formats member sender with seq and timestamp", () => {
    const msg = makeMsg("architect", "sync done", 7, FIXED_TS);
    expect(wrapRoomContextMessage(msg, "bossmode dev", "member")).toBe(
      "[Message from room \"bossmode dev\". Member `architect`, No.7, 07-17 14:32]\n\nsync done",
    );
  });

  it("wrapRoomContextMessage omits No. when seq is absent (legacy unmigrated message)", () => {
    const msg = makeMsg("user", "hello", undefined, FIXED_TS);
    expect(wrapRoomContextMessage(msg, "bossmode dev", "user")).toBe(
      "[Message from room \"bossmode dev\". User `fish`, 07-17 14:32]\n\nhello",
    );
  });

  it("wrapRoomMessagesTranscript formats multiple messages with a shared header and per-message sub-headers", () => {
    const messages = [
      { msg: makeMsg("user", "message B", 10236, FIXED_TS), role: "user" as const },
      { msg: makeMsg("qa", "message C", 10237, FIXED_TS), role: "member" as const },
    ];
    expect(wrapRoomMessagesTranscript(messages, "bossmode dev")).toBe(
      "[Messages from room \"bossmode dev\"]\n\n[User `fish`, No.10236, 07-17 14:32]\n\nmessage B\n\n\n[Member `qa`, No.10237, 07-17 14:32]\n\nmessage C",
    );
  });

  it("escapes quotes in room and sender labels", () => {
    const msg = makeMsg('dev"ops', "quoted", 1, FIXED_TS);
    expect(wrapRoomContextMessage(msg, 'boss"mode', "member")).toContain('room "boss\\"mode"');
    expect(wrapRoomContextMessage(msg, 'boss"mode', "member")).toContain('`dev\\"ops`');
  });

  it("supports empty content", () => {
    const msg = makeMsg("user", "", 1, FIXED_TS);
    expect(wrapRoomContextMessage(msg, "bossmode dev", "user")).toBe(
      "[Message from room \"bossmode dev\". User `fish`, No.1, 07-17 14:32]\n\n",
    );
  });

  it("resolveSenderRole maps user vs others", () => {
    expect(resolveSenderRole("user")).toBe("user");
    expect(resolveSenderRole("pm")).toBe("member");
    expect(resolveSenderRole("system")).toBe("member");
  });
});
