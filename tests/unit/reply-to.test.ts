import { describe, expect, it } from "vitest";
import { parseReplyToParam, excerptForReply } from "../../src/engine/tools.js";
import { formatReplyQuoteBlock, wrapRoomContextMessage } from "../../src/engine/message-envelope.js";
import type { RoomMessage } from "../../src/shared/types.js";

function msg(partial: Partial<RoomMessage> & { id: string; seq: number; content: string }): RoomMessage {
  return {
    sender: "user",
    mentions: [],
    ts: Date.now(),
    ...partial,
  };
}

describe("parseReplyToParam", () => {
  const scope = [
    msg({ id: "m1", seq: 1, content: "hello", sender: "user" }),
    msg({ id: "m2", seq: 2, content: "world", sender: "pm" }),
  ];

  it("accepts msg:#seq when target exists", () => {
    const r = parseReplyToParam("msg:#2", scope);
    expect(r.ok).toBe(true);
    if (r.ok && r.replyTo) {
      expect(r.replyTo).toEqual({ seq: 2, messageId: "m2" });
    }
  });

  it("rejects non-matching format", () => {
    const r = parseReplyToParam("msg:2", scope);
    expect(r.ok).toBe(false);
  });

  it("rejects missing seq in scope", () => {
    const r = parseReplyToParam("msg:#99", scope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });

  it("rejects non-numeric", () => {
    const r = parseReplyToParam("msg:#abc", scope);
    expect(r.ok).toBe(false);
  });

  it("omits when undefined", () => {
    const r = parseReplyToParam(undefined, scope);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replyTo).toBeUndefined();
  });
});

describe("reply quote envelope", () => {
  it("attaches excerpt when target resolvable", () => {
    const target = msg({ id: "m1", seq: 10, content: "original body here", sender: "designer" });
    const reply = msg({
      id: "m2",
      seq: 11,
      content: "ack",
      sender: "pm",
      replyTo: { seq: 10, messageId: "m1" },
    });
    const quote = formatReplyQuoteBlock(reply, (ref) => (ref.messageId === "m1" ? target : undefined));
    expect(quote).toMatch(/msg:#10/);
    expect(quote).toMatch(/designer/);
    expect(quote).toMatch(/original body here/);
  });

  it("degrades without blocking when target missing", () => {
    const reply = msg({
      id: "m2",
      seq: 11,
      content: "ack",
      sender: "pm",
      replyTo: { seq: 10, messageId: "gone" },
    });
    const quote = formatReplyQuoteBlock(reply, () => undefined);
    expect(quote).toMatch(/not visible/i);
  });

  it("wrapRoomContextMessage includes quote before body", () => {
    const target = msg({ id: "m1", seq: 5, content: "the ask", sender: "user" });
    const reply = msg({
      id: "m2",
      seq: 6,
      content: "doing it",
      sender: "developer",
      replyTo: { seq: 5, messageId: "m1" },
    });
    const text = wrapRoomContextMessage(reply, "bossmode dev", "member", (r) =>
      r.messageId === "m1" ? target : undefined,
    );
    expect(text).toContain("In reply to msg:#5");
    expect(text).toContain("doing it");
    expect(text.indexOf("In reply to")).toBeLessThan(text.indexOf("doing it"));
  });

  it("excerpt truncates long content", () => {
    const long = "x".repeat(500);
    expect(excerptForReply(long).length).toBeLessThanOrEqual(200);
    expect(excerptForReply(long).endsWith("…")).toBe(true);
  });
});
