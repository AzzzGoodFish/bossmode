/**
 * rc.8 read-chain presentation: shared member-view renderer for
 * chat_read — seq header, replyTo quote, attachments; inline + file.
 */
import { coreFixture } from "../helpers/core-fixture.js";
import { SettingsRepository } from "../../src/data/repositories/settings.js";
import { getDefaultConfig } from "../../src/config/config.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BOSSMODE_DIR!;
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  new SettingsRepository(fixture.db).importConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } });
  new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] });
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

vi.mock("../../src/server/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/ws.js")>();
  return { ...actual, broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn() };
});

describe("query renderer (member view)", () => {
  it("row renderer: seq header + replyTo quote + content + attachment, unavailable variant", async () => {
    const { renderQueryRowForMember, renderQueryRowsForMember } = await import("../../src/agent/tools/query-render.js");
    const row = {
      seq: 42,
      sender: "qa",
      content: "report done",
      ts: 1780000000000,
      replyTo: { seq: 40, messageId: "m40", sender: "pm", excerpt: "please run checks" },
      attachments: [{ originalFilename: "report.md", path: "/x/report.md" }],
    };
    const text = renderQueryRowForMember(row);
    expect(text).toContain("[No.42 · qa · ");
    expect(text).toContain('[In reply to msg:#40 from pm]: "please run checks"');
    expect(text).toContain("report done");
    expect(text).toContain("Attachment: [original filename: report.md](/x/report.md)");

    const lost = renderQueryRowForMember({
      seq: 43,
      sender: "qa",
      content: "hmm",
      replyTo: { seq: 1, messageId: "gone", unavailable: true },
    });
    expect(lost).toContain("[In reply to msg:#1 — original not visible in this context]");

    expect(renderQueryRowsForMember([])).toBe("No messages found.");
  });

  it("sender display-name mapping: user renders as the auth username, members untouched", async () => {
    const { renderQueryRowForMember } = await import("../../src/agent/tools/query-render.js");
    const row = {
      seq: 7,
      sender: "user",
      content: "from the human",
      ts: 1780000000000,
      replyTo: { seq: 6, messageId: "m6", sender: "user", excerpt: "earlier human line" },
    };
    const text = renderQueryRowForMember(row);
    expect(text).toContain("[No.7 · fish · ");
    expect(text).toContain('[In reply to msg:#6 from fish]: "earlier human line"');
    expect(text).not.toContain("· user ·");
    expect(text).not.toContain("from user]");

    const member = renderQueryRowForMember({
      seq: 8,
      sender: "qa",
      content: "member line",
      ts: 1780000000001,
      replyTo: { seq: 7, messageId: "m7", sender: "pm", excerpt: "pm line" },
    });
    expect(member).toContain("[No.8 · qa · ");
    expect(member).toContain('[In reply to msg:#7 from pm]: "pm line"');
  });

  it("inline query result rendered by the SDK carries seq/replyTo/attachment (through tool rows)", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const m = reg.createMember({ name: "pm" });
    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.createRoom("R", dir, []);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const attachDir = join(dir, "rooms", room.id, "attachments");
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, "rep1.md"), "# r", "utf-8");

    const messageStore = await import("../../src/chat/message-store.js");
    const base = messageStore.addMessage(room.id, {
      mentions: [],
      sender: "pm",
      content: "please run checks",
    });
    messageStore.addMessage(room.id, {
      mentions: [],
      sender: "user",
      content: "report attached",
      attachments: [{ storedFilename: "rep1.md", originalFilename: "report.md", size: 3 }],
      replyTo: { seq: base.seq, messageId: base.id },
    });

    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const rows = (await handleToolCallback("chat_read", room.id, "pm", { limit: 1 })) as any[];
    const row = rows[0];
    expect(row.seq).toBe(base.seq + 1);
    expect(row.replyTo.sender).toBe("pm");
    expect(row.replyTo.excerpt).toContain("please run checks");
    expect(row.attachments[0].path).toContain("rep1.md");

    // SDK renderer consumes the same rows
    const { renderQueryRowsForMember } = await import("../../src/agent/tools/query-render.js");
    const text = renderQueryRowsForMember(rows);
    expect(text).toContain(`[No.${row.seq} · fish ·`);
    expect(text).toContain(`[In reply to msg:#${base.seq} from pm]: "please run checks"`);
    expect(text).toContain("Attachment: [original filename: report.md]");
  });

  it("file output matches inline shape (same renderer): seq + replyTo + attachment lines", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const m = reg.createMember({ name: "pm" });
    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.createRoom("R2", dir, []);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const attachDir = join(dir, "rooms", room.id, "attachments");
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, "rep2.md"), "# r2", "utf-8");

    const messageStore = await import("../../src/chat/message-store.js");
    const base = messageStore.addMessage(room.id, { mentions: [], sender: "pm", content: "origin note" });
    messageStore.addMessage(room.id, {
      mentions: [],
      sender: "user",
      content: "reply with file",
      attachments: [{ storedFilename: "rep2.md", originalFilename: "notes.md", size: 4 }],
      replyTo: { seq: base.seq, messageId: base.id },
    });

    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const fileRes = (await handleToolCallback("chat_read", room.id, "pm", {
      output: "file",
    })) as any;
    const md = readFileSync(fileRes.path, "utf-8");
    rmSync(fileRes.path);
    expect(md).toContain(`[No.${base.seq + 1} · fish ·`);
    expect(md).toContain(`[In reply to msg:#${base.seq} from pm]: "origin note"`);
    expect(md).toContain("Attachment: [original filename: notes.md](" + join(attachDir, "rep2.md") + ")");
  });

  it("cross-window reply target resolves from the full scope; lost target degrades", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const m = reg.createMember({ name: "pm" });
    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.createRoom("R3", dir, []);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const messageStore = await import("../../src/chat/message-store.js");
    // Old message (outside the 1-message page window)
    const old = messageStore.addMessage(room.id, { mentions: [], sender: "qa", content: "ancient origin" });
    // Reply (page window of 1 sees only this)
    messageStore.addMessage(room.id, {
      mentions: [],
      sender: "pm",
      content: "replying across the window",
      replyTo: { seq: old.seq, messageId: old.id },
    });
    // Reply to a target that does not exist anywhere in scope
    messageStore.addMessage(room.id, {
      mentions: [],
      sender: "pm",
      content: "replying into the void",
      replyTo: { seq: 9999, messageId: "missing" },
    });

    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const rows = (await handleToolCallback("chat_read", room.id, "pm", {
      from_seq: old.seq,
    })) as any[];
    const cross = rows.find((r) => r.content === "replying across the window");
    expect(cross?.replyTo.sender).toBe("qa");
    expect(cross?.replyTo.excerpt).toContain("ancient origin");

    const lost = rows.find((r) => r.content === "replying into the void");
    expect(lost?.replyTo.unavailable).toBe(true);
    const { renderQueryRowForMember } = await import("../../src/agent/tools/query-render.js");
    expect(renderQueryRowForMember(lost)).toContain(
      "[In reply to msg:#9999 — original not visible in this context]",
    );
  });

  it("dm output preserves attachment ownership and does not resolve foreign reply targets", async () => {
    const { createMember } = await import("../../src/member/member-registry.js");
    const { createRoom, inviteGlobalMember } = await import("../../src/chat/room-store.js");
    const { addMessage } = await import("../../src/chat/message-store.js");
    const { getDmAttachmentPath } = await import("../../src/files/attachment-store.js");
    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const { renderQueryRowsForMember } = await import("../../src/agent/tools/query-render.js");
    const { dirname } = await import("node:path");
    const member = createMember({ name: "reader" });
    const room = createRoom("Read scopes", undefined, []);
    inviteGlobalMember(room.id, { id: member.id, name: member.name });
    const foreign = addMessage(room.id, { sender: "user", content: "room-only target", mentions: [] });
    const scope = `dm:${member.id}`;
    const path = getDmAttachmentPath(member.id, "report.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "😀");
    addMessage(scope, { sender: "user", content: "scoped reply", mentions: [],
      replyTo: { messageId: foreign.id, seq: foreign.seq! },
      attachments: [
        { storedFilename: "report.md", originalFilename: "report.md", size: 4 },
        { storedFilename: "missing.md", originalFilename: "missing.md", size: 0 },
        { storedFilename: "../report.md", originalFilename: "invalid.md", size: 4 },
      ],
    });
    fixture.reopen();
    const rows = await handleToolCallback("chat_read", scope, member.id, {}) as import("../../src/agent/tools/query-render.js").QueryRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].replyTo).toMatchObject({ messageId: foreign.id, unavailable: true });
    expect(rows[0].attachments).toEqual([
      { originalFilename: "report.md", path },
      { originalFilename: "missing.md", path: "unavailable" },
      { originalFilename: "invalid.md", path: "unavailable" },
    ]);
    const inline = renderQueryRowsForMember(rows);
    expect(inline).not.toContain("room-only target");
    expect(inline).toContain("original not visible in this context");
    const result = await handleToolCallback("chat_read", scope, member.id, { output: "file" }) as { path: string };
    try { expect(readFileSync(result.path, "utf8")).toContain(inline); }
    finally { rmSync(result.path); }
  });
});
