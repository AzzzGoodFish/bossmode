import { describe, expect, it } from "vitest";
import { excerptForReply } from "../../src/agent/tools/tools.js";
import { formatReplyQuoteBlock, wrapRoomContextMessage } from "../../src/agent/prompt.js";
import type { RoomMessage } from "../../src/kernel/types.js";

function msg(partial: Partial<RoomMessage> & { id: string; seq: number; content: string }): RoomMessage {
  return {
    sender: "user",
    mentions: [],
    ts: Date.now(),
    ...partial,
  };
}

describe("reply quote envelope", () => {
  it("omits the quote when the stored message has no reply target", () => {
    const plain = msg({ id: "m1", seq: 1, content: "plain message" });
    expect(formatReplyQuoteBlock(plain)).toBe("");
    expect(wrapRoomContextMessage(plain, "R", "user")).not.toContain("In reply to");
  });

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
