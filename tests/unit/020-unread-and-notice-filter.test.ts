/**
 * 0.20 read-cursor + system-notice eligibility (fish 2026-08-04 ruling):
 * - chats-list unread/mention counts exclude system notices and typed
 *   task/knowledge events (only real conversation badges);
 * - member-facing history reads (query_room_messages) hide runtime-failure
 *   system notices, same as the activation-context injection path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

function msg(sender: string, content: string, extra: Record<string, unknown> = {}) {
  return { id: `m-${Math.random().toString(36).slice(2, 8)}`, sender, content, mentions: [], ts: Date.now(), ...extra } as any;
}

describe("unread eligibility (chats list)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-unread-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts only real conversation; system notices and typed events never badge", async () => {
    const { countUserUnreadAndMention } = await import("../../src/api/members.js");
    const messages = [
      msg("user", "hello"),                       // own message — never unread
      msg("pm", "reply one"),                     // counts
      msg("system", "Member \"pm\" request failed. boom"),  // system notice — excluded
      msg("system", "Task created: x", { type: "task_event" }), // typed — excluded
      msg("pm", "doc updated", { type: "knowledge_event" }),    // typed — excluded
      msg("architect", "reply two @fish"),        // counts + mention
    ];
    const { unreadCount, mentioned } = countUserUnreadAndMention(messages, null, null, "fish");
    expect(unreadCount).toBe(2);
    expect(mentioned).toBe(true);
  });

  it("mention detection ignores system notices containing @user", async () => {
    const { countUserUnreadAndMention } = await import("../../src/api/members.js");
    const messages = [
      msg("system", "Member \"pm\" request failed. cc @fish"),
      msg("system", "Task assigned to @fish", { type: "task_event" }),
    ];
    const { unreadCount, mentioned } = countUserUnreadAndMention(messages, null, null, "fish");
    expect(unreadCount).toBe(0);
    expect(mentioned).toBe(false);
  });
});

describe("query_room_messages member-visible filter", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-qrm-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "pm.md"), `---\nname: pm\n---\npm`, "utf-8");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hides ALL system notices (failures + non-error prompts) but keeps conversation and typed events", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const messageStore = await import("../../src/workspace/message-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", dir, [{ agent: "pm", name: "pm" }], undefined);

    messageStore.addMessage(room.id, msg("user", "REAL-USER-MSG"));
    messageStore.addMessage(room.id, msg("pm", "REAL-MEMBER-MSG"));
    messageStore.addMessage(room.id, msg("system", "Member \"pm\" request failed. runtime blew up with a long stack trace"));
    messageStore.addMessage(room.id, msg("system", "Member \"pm\" finished without replying."));
    messageStore.addMessage(room.id, msg("system", "Member \"pm\" hasn't selected a model yet. Open the member card."));
    messageStore.addMessage(room.id, msg("system", "TASKEVENT-KEPT", { type: "task_event" }));
    messageStore.addMessage(room.id, msg("system", "KNOWLEDGEEVENT-KEPT", { type: "knowledge_event" }));

    const result = (await handleToolCallback("query_room_messages", room.id, "pm", {})) as any[];
    const texts = result.map((m: any) => m.content).join("\n");
    expect(texts).toContain("REAL-USER-MSG");
    expect(texts).toContain("REAL-MEMBER-MSG");
    expect(texts).toContain("TASKEVENT-KEPT");
    expect(texts).toContain("KNOWLEDGEEVENT-KEPT");
    expect(texts).not.toContain("request failed");
    expect(texts).not.toContain("finished without replying");
    expect(texts).not.toContain("hasn't selected a model");
  });
});
