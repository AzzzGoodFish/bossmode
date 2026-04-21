import { describe, expect, it } from "vitest";
import {
  PRIVATE_REPLY_FOOTER,
  ROOM_REPLY_FOOTER,
  resolveSenderRole,
  wrapPrivateMessage,
  wrapRoomContextMessage,
  wrapRoomMentionMessage,
} from "../../src/engine/message-envelope.js";
import type { RoomMessage } from "../../src/shared/types.js";

function makeMsg(sender: string, content: string, mentions: string[] = []): RoomMessage {
  return {
    id: `msg-${sender}`,
    sender,
    content,
    mentions,
    ts: Date.now(),
  };
}

describe("message envelope wrappers", () => {
  it("wrapRoomContextMessage formats user sender with display name", () => {
    const msg = makeMsg("user", "hello");
    expect(wrapRoomContextMessage(msg, "bossmode dev", "user")).toBe(
      "[Message from room \"bossmode dev\", from user @fish]\n\nhello",
    );
  });

  it("wrapRoomContextMessage formats member sender", () => {
    const msg = makeMsg("architect", "sync done");
    expect(wrapRoomContextMessage(msg, "bossmode dev", "member")).toBe(
      "[Message from room \"bossmode dev\", from member @architect]\n\nsync done",
    );
  });

  it("wrapRoomMentionMessage formats user sender with display name", () => {
    const msg = makeMsg("user", "@pm status", ["pm"]);
    expect(wrapRoomMentionMessage(msg, "bossmode dev", "user", "pm")).toBe(
      "[Message from room \"bossmode dev\", mentioned by user @fish]\n\n@pm status",
    );
  });

  it("wrapRoomMentionMessage formats member sender", () => {
    const msg = makeMsg("architect", "@pm status", ["pm"]);
    expect(wrapRoomMentionMessage(msg, "bossmode dev", "member", "pm")).toBe(
      "[Message from room \"bossmode dev\", mentioned by member @architect]\n\n@pm status",
    );
  });

  it("wrapPrivateMessage formats private envelope", () => {
    expect(wrapPrivateMessage("check release risk", "fish")).toBe(
      "[Private message from user @fish]\n\ncheck release risk",
    );
  });

  it("escapes quotes in room and sender labels", () => {
    const msg = makeMsg('dev\"ops', "quoted");
    expect(wrapRoomContextMessage(msg, 'boss\"mode', "member")).toContain('room "boss\\"mode"');
    expect(wrapRoomContextMessage(msg, 'boss\"mode', "member")).toContain('@dev\\"ops');
  });

  it("supports empty content", () => {
    const msg = makeMsg("user", "");
    expect(wrapRoomMentionMessage(msg, "bossmode dev", "user", "pm")).toBe(
      "[Message from room \"bossmode dev\", mentioned by user @fish]\n\n",
    );
  });

  it("exports canonical footer constants", () => {
    expect(ROOM_REPLY_FOOTER).toContain('target="room"');
    expect(PRIVATE_REPLY_FOOTER).toContain('target="user"');
  });

  it("resolveSenderRole maps user vs others", () => {
    expect(resolveSenderRole("user")).toBe("user");
    expect(resolveSenderRole("pm")).toBe("member");
    expect(resolveSenderRole("system")).toBe("member");
  });
});
