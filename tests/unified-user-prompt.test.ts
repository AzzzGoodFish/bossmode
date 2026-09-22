/**
 * Unified user prompt spec v1.6 regression probes.
 *
 * Covers: chat_message envelope snapshots for all three chat kinds (with
 * quote/attachment/last_read), the dm_activation
 * and context_recovery platform directives, isPlatformInjection detection,
 * and the absence of the retired REPLY EXPECTED / length-continuation paths.
 */
import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { renderChatInput, type ChatContextSnapshot } from "../src/chat/context.js";
import { isPlatformInjection } from "../src/agent/injection.js";
import { recoveryPrompt } from "../src/agent/runtime/context-recovery.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function baseSnapshot(overrides: Partial<ChatContextSnapshot>): ChatContextSnapshot {
  return {
    sourceRef: "room:rm_testroom01",
    kind: "room",
    chatName: "Test Room",
    chatShortId: "rm_testroom01",
    lastRead: null,
    trigger: { id: "m3", ts: Date.UTC(2026, 8, 21, 2, 9), sender: "fish", content: "@言实 查一下", seq: 3 },
    replyTarget: null,
    unread: null,
    attachmentLocation: { kind: "room", roomId: "rm_testroom01" },
    cursor: null,
    replyExpected: true,
    ...overrides,
  } as ChatContextSnapshot;
}

describe("chat_message envelope (spec v1.6)", () => {
  it("room message renders one element with the frozen attributes", () => {
    const prompt = renderChatInput(baseSnapshot({})).prompt;
    expect(prompt).toBe(
      `<chat_message chat_name="Test Room" chat_id="rm_testroom01" chat_type="channel" sender_id="user" sender_name="fish" msg_id="3" at="2026-09-21 02:09">\n` +
      "@言实 查一下\n" +
      "</chat_message>");
    expect(prompt).not.toContain("REPLY EXPECTED");
    expect(prompt).not.toContain("Earlier in this room");
  });

  it("last_read, quote (50 chars) and attachment render as frozen fields", () => {
    const long = "字".repeat(80);
    const snapshot = baseSnapshot({
      lastRead: 22011,
      trigger: {
        id: "m4", ts: Date.UTC(2026, 8, 21, 2, 9), sender: "fish", content: "正文", seq: 4,
        replyTo: { messageId: "m2", seq: 2 },
        attachments: [{ storedFilename: "a.png", originalFilename: "clip.png" }],
      },
      replyTarget: { id: "m2", ts: 1, sender: "designer", content: long, seq: 2 },
    });
    const prompt = renderChatInput(snapshot).prompt;
    expect(prompt).toContain('last_read="22011"');
    expect(prompt).toContain('<quote msg_id="2" sender_name="designer">');
    const quoted = /<quote[^>]*>(.*)<\/quote>/.exec(prompt)![1];
    expect(quoted.length).toBe(50);
    expect(prompt).toContain('<attachment filename="clip.png"');
    // quote(1) + body(1) + attachment(1) lines stay inside the element
    expect(prompt.endsWith("</chat_message>")).toBe(true);
  });

  it("unavailable quote and dm kinds keep the same shape", () => {
    const unavailable = renderChatInput(baseSnapshot({
      trigger: { id: "m5", ts: 1, sender: "fish", content: "hi", seq: 5, replyTo: { messageId: "gone", seq: 9 } },
    })).prompt;
    expect(unavailable).toContain('<quote msg_id="9" unavailable="true"/>');
    const dm = renderChatInput(baseSnapshot({
      sourceRef: "dm:mem_ey1utklman", kind: "dm", chatName: "user", chatShortId: "dm_ey1utklman",
      trigger: { id: "m6", ts: 1, sender: "fish", content: "收到", seq: 6 },
    })).prompt;
    expect(dm).toContain('chat_name="user" chat_id="dm_ey1utklman" chat_type="dm" sender_id="user"');
    const mm = renderChatInput(baseSnapshot({
      sourceRef: "mm:mem_aaa1111111-mem_bbb2222222", kind: "mm", chatName: "Luca", chatShortId: "dm_7k2qwx9f4r",
      trigger: { id: "m7", ts: 1, sender: "Cole", senderMemberId: "mem_bbb2222222", content: "done", seq: 7 },
    })).prompt;
    expect(mm).toContain('chat_name="Luca" chat_id="dm_7k2qwx9f4r" chat_type="dm" sender_id="mem_bbb2222222"');
  });

  it("escapes XML-special characters in attributes and text", () => {
    const prompt = renderChatInput(baseSnapshot({
      chatName: `A "quoted" & <room>`,
      trigger: { id: "m8", ts: 1, sender: "a&b<c>", content: "x & < y", seq: 8 },
    })).prompt;
    expect(prompt).toContain('chat_name="A &quot;quoted&quot; &amp; &lt;room&gt;"');
    expect(prompt).toContain("x &amp; &lt; y");
  });
});

describe("platform directives (spec v1.6)", () => {
  it("context recovery prompt is a single directive element with boundary and chat", () => {
    const prompt = recoveryPrompt("/work/s.jsonl", "room:rm_fixture", "0f73e15c");
    expect(prompt.startsWith('<platform_directive kind="context_recovery" boundary="0f73e15c" chat_id="rm_fixture">')).toBe(true);
    expect(prompt.endsWith("</platform_directive>")).toBe(true);
    expect(prompt).toContain("Internal context recovery:");
    expect(isPlatformInjection(prompt)).toBe(true);
  });

  it("dm activation directive shape", () => {
    const prompt = `<platform_directive kind="dm_activation" chat_id="dm_ey1utklman" persona="empty">\nYou are now in a private chat with the user. Introduce yourself briefly with chat_send and ask what they want you around for.\n</platform_directive>`;
    expect(isPlatformInjection(prompt)).toBe(true);
  });

  it("isPlatformInjection separates synthetic inputs from chat traffic", () => {
    expect(isPlatformInjection("  \n<platform_directive kind=\"context_recovery\" boundary=\"x\"/>\n ")).toBe(true);
    expect(isPlatformInjection("<chat_message chat_id=\"rm_x\">\nhi\n</chat_message>")).toBe(false);
    expect(isPlatformInjection("<chat_message>a</chat_message>\n\n<chat_message>b</chat_message>")).toBe(false);
    expect(isPlatformInjection("Plain user text")).toBe(false);
    expect(isPlatformInjection("<platform_directive>a</platform_directive>\n<platform_directive>b</platform_directive>")).toBe(false);
    expect(isPlatformInjection("<platform_directive kind=\"x\">outer <platform_directive>nested</platform_directive></platform_directive>")).toBe(false);
  });
});
