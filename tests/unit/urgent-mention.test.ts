/**
 * Urgent `!name` gesture — parser boundaries + router split (fish 2026-08-04).
 *
 * Locks:
 * - `!name` matches only real member names with a left boundary
 *   ("Hello!pm", "wow!!pm", full-width `！` never fire)
 * - `!all` is not a thing
 * - persisted urgentMentionMemberIds route through onUrgentMention; the rest
 *   keep the normal onMention path; self-mentions are skipped either way
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ tmpDir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.tmpDir,
}));

import { parseMentions, parseUrgentMentions, parseUrgentMentionMemberIds, initRouter } from "../../src/communication/router.js";
import { postMessage } from "../../src/communication/message-bus.js";

const MEMBERS = ["pm", "qa", "dev-ben"];
const MEMBER_RECORDS = [
  { id: "rm_pm", name: "pm" },
  { id: "rm_qa", name: "qa" },
  { id: "rm_devben", name: "dev-ben" },
] as any[];

beforeEach(() => {
  state.tmpDir = mkdtempSync(join(tmpdir(), "bossmode-urgent-"));
  mkdirSync(join(state.tmpDir, "rooms", "room-a"), { recursive: true });
});

afterEach(() => {
  rmSync(state.tmpDir, { recursive: true, force: true });
});

describe("parseUrgentMentions", () => {
  it("matches member names at message start and after whitespace/punctuation", () => {
    expect(parseUrgentMentions("!pm please stop and reply", MEMBERS)).toEqual(["pm"]);
    expect(parseUrgentMentions("see above. !qa now", MEMBERS)).toEqual(["qa"]);
    expect(parseUrgentMentions("(!dev-ben) asap", MEMBERS)).toEqual(["dev-ben"]);
  });

  it("never fires when glued to a word char or another bang", () => {
    expect(parseUrgentMentions("Hello!pm how are you", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("wow!!pm", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("great!pm", MEMBERS)).toEqual([]);
  });

  it("never fires on full-width ！, non-members, or !all", () => {
    expect(parseUrgentMentions("！pm 全角不算", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("!ghost nobody", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("!all stop everything", MEMBERS)).toEqual([]);
  });

  it("coexists with @ mentions and dedupes", () => {
    expect(parseUrgentMentions("@qa look, and !pm !pm now", MEMBERS)).toEqual(["pm"]);
  });

  it("code segments are literal text: backticked !name never parses (inline + fenced)", () => {
    expect(parseUrgentMentions("对照 `!pm` 应字面", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("```\n!pm in a fence\n```", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("real !pm plus `!qa`", MEMBERS)).toEqual(["pm"]);
    // unclosed fence runs to end
    expect(parseUrgentMentions("```\n!pm", MEMBERS)).toEqual([]);
  });

  it("@ follows the same rule: code-span @name never activates", () => {
    expect(parseMentions("讨论 `@pm` 这个手势", MEMBERS)).toEqual([]);
    expect(parseMentions("```\n@pm fenced\n```", MEMBERS)).toEqual([]);
    expect(parseMentions("real @pm plus `@qa`", MEMBERS)).toEqual(["pm"]);
    expect(parseMentions("`@all` fenced out", MEMBERS)).toEqual([]);
  });

  it("maps to member ids", () => {
    expect(parseUrgentMentionMemberIds("!pm and !qa", MEMBER_RECORDS)).toEqual(["rm_pm", "rm_qa"]);
    expect(parseUrgentMentionMemberIds("Hello!pm", MEMBER_RECORDS)).toEqual([]);
  });
});

describe("router urgent split", () => {
  it("routes urgent ids through onUrgentMention with the sender name", () => {
    const onMention = vi.fn();
    const onMentionAll = vi.fn();
    const onUrgent = vi.fn();
    const unsub = initRouter(onMention, onMentionAll, onUrgent);

    postMessage("room-a", "qa", "!pm stop and reply", ["pm"], {
      senderMemberId: "rm_qa",
      mentionMemberIds: ["rm_pm"],
      urgentMentions: ["pm"],
      urgentMentionMemberIds: ["rm_pm"],
    });

    expect(onUrgent).toHaveBeenCalledWith("room-a", "rm_pm", "qa");
    expect(onMention).not.toHaveBeenCalled();
    expect(onMentionAll).not.toHaveBeenCalled();
    unsub();
  });

  it("splits mixed messages: urgent → interrupt, plain → normal mention", () => {
    const onMention = vi.fn();
    const onUrgent = vi.fn();
    const unsub = initRouter(onMention, vi.fn(), onUrgent);

    postMessage("room-a", "qa", "@dev-ben when free; !pm NOW", ["dev-ben", "pm"], {
      senderMemberId: "rm_qa",
      mentionMemberIds: ["rm_devben", "rm_pm"],
      urgentMentions: ["pm"],
      urgentMentionMemberIds: ["rm_pm"],
    });

    expect(onUrgent).toHaveBeenCalledTimes(1);
    expect(onUrgent).toHaveBeenCalledWith("room-a", "rm_pm", "qa");
    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention).toHaveBeenCalledWith("room-a", "rm_devben", expect.objectContaining({ senderName: "qa" }));
    unsub();
  });

  it("skips self-urgent and degrades to onMention when no urgent callback is wired", () => {
    const onMention = vi.fn();
    const onUrgent = vi.fn();
    const unsub = initRouter(onMention, vi.fn(), onUrgent);

    postMessage("room-a", "pm", "!pm note to self", ["pm"], {
      senderMemberId: "rm_pm",
      mentionMemberIds: ["rm_pm"],
      urgentMentions: ["pm"],
      urgentMentionMemberIds: ["rm_pm"],
    });
    expect(onUrgent).not.toHaveBeenCalled();
    expect(onMention).not.toHaveBeenCalled();
    unsub();

    const unsub2 = initRouter(onMention, vi.fn());
    postMessage("room-a", "qa", "!pm legacy listener", ["pm"], {
      senderMemberId: "rm_qa",
      mentionMemberIds: ["rm_pm"],
      urgentMentions: ["pm"],
      urgentMentionMemberIds: ["rm_pm"],
    });
    expect(onMention).toHaveBeenCalledWith("room-a", "rm_pm", expect.objectContaining({ senderName: "qa" }));
    unsub2();
  });
});
