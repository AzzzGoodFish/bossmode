/**
 * rc.8 read-chain presentation: shared member-view renderer for
 * query_room_messages — seq header, replyTo quote, attachments; inline + file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir = "";

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return { ...actual, broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn() };
});

const PROFILE = {
  name: "Test provider",
  providerSlug: "testprov",
  protocol: "openai-responses" as const,
  baseUrl: "https://example.invalid/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [{ id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-query-render-"));
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "pm.md"), "---\nname: pm\n---\n\nYou are pm.\n", "utf-8");
  vi.resetModules();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("query renderer (member view)", () => {
  it("row renderer: seq header + replyTo quote + content + attachment, unavailable variant", async () => {
    const { renderQueryRowForMember, renderQueryRowsForMember } = await import("../../src/engine/query-render.js");
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

  it("inline query result rendered by the SDK carries seq/replyTo/attachment (through tool rows)", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const creds = await import("../../src/engine/model-credentials.js");
    creds.saveModelCredentialProfile(PROFILE);
    const m = reg.createMember({ name: "pm", model: "testprov/claude-a", credentialId: "x" });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("R", dir, [{ agent: "pm", name: "pm" }]);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const attachDir = join(dir, ".bossmode-attachments");
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, "rep1.md"), "# r", "utf-8");

    const messageStore = await import("../../src/workspace/message-store.js");
    const base = messageStore.addMessage(room.id, {
      id: "m40",
      sender: "pm",
      content: "please run checks",
    });
    messageStore.addMessage(room.id, {
      id: "m41",
      sender: "user",
      content: "report attached",
      attachments: [{ storedFilename: "rep1.md", originalFilename: "report.md", size: 3 }],
      replyTo: { seq: base.seq, messageId: base.id },
    });

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const rows = (await handleToolCallback("query_room_messages", room.id, "pm", { limit: 1 })) as any[];
    const row = rows[0];
    expect(row.seq).toBe(base.seq + 1);
    expect(row.replyTo.sender).toBe("pm");
    expect(row.replyTo.excerpt).toContain("please run checks");
    expect(row.attachments[0].path).toContain("rep1.md");

    // SDK renderer consumes the same rows
    const { renderQueryRowsForMember } = await import("../../src/engine/query-render.js");
    const text = renderQueryRowsForMember(rows);
    expect(text).toContain(`[No.${row.seq} · user ·`);
    expect(text).toContain(`[In reply to msg:#${base.seq} from pm]: "please run checks"`);
    expect(text).toContain("Attachment: [original filename: report.md]");
  });

  it("file output matches inline shape (same renderer): seq + replyTo + attachment lines", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const creds = await import("../../src/engine/model-credentials.js");
    creds.saveModelCredentialProfile(PROFILE);
    const m = reg.createMember({ name: "pm", model: "testprov/claude-a", credentialId: "x" });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("R2", dir, [{ agent: "pm", name: "pm" }]);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const attachDir = join(dir, ".bossmode-attachments");
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(join(attachDir, "rep2.md"), "# r2", "utf-8");

    const messageStore = await import("../../src/workspace/message-store.js");
    const base = messageStore.addMessage(room.id, { id: "b1", sender: "pm", content: "origin note" });
    messageStore.addMessage(room.id, {
      id: "b2",
      sender: "user",
      content: "reply with file",
      attachments: [{ storedFilename: "rep2.md", originalFilename: "notes.md", size: 4 }],
      replyTo: { seq: base.seq, messageId: base.id },
    });

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const fileRes = (await handleToolCallback("query_room_messages", room.id, "pm", {
      output: "file",
    })) as any;
    const md = readFileSync(fileRes.path, "utf-8");
    expect(md).toContain(`[No.${base.seq + 1} · user ·`);
    expect(md).toContain(`[In reply to msg:#${base.seq} from pm]: "origin note"`);
    expect(md).toContain("Attachment: [original filename: notes.md](" + join(attachDir, "rep2.md") + ")");
  });

  it("cross-window reply target resolves from the full scope; lost target degrades", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const creds = await import("../../src/engine/model-credentials.js");
    creds.saveModelCredentialProfile(PROFILE);
    const m = reg.createMember({ name: "pm", model: "testprov/claude-a", credentialId: "x" });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("R3", dir, [{ agent: "pm", name: "pm" }]);
    roomStore.inviteGlobalMember(room.id, { id: m.id, name: "pm" });

    const messageStore = await import("../../src/workspace/message-store.js");
    // Old message (outside the 1-message page window)
    const old = messageStore.addMessage(room.id, { id: "old1", sender: "qa", content: "ancient origin" });
    // Reply (page window of 1 sees only this)
    messageStore.addMessage(room.id, {
      id: "new1",
      sender: "pm",
      content: "replying across the window",
      replyTo: { seq: old.seq, messageId: old.id },
    });
    // Reply to a target that does not exist anywhere in scope
    messageStore.addMessage(room.id, {
      id: "new2",
      sender: "pm",
      content: "replying into the void",
      replyTo: { seq: 9999, messageId: "missing" },
    });

    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const rows = (await handleToolCallback("query_room_messages", room.id, "pm", {
      from: "pm",
      from_seq: old.seq,
    })) as any[];
    const cross = rows.find((r) => r.content === "replying across the window");
    expect(cross?.replyTo.sender).toBe("qa");
    expect(cross?.replyTo.excerpt).toContain("ancient origin");

    const lost = rows.find((r) => r.content === "replying into the void");
    expect(lost?.replyTo.unavailable).toBe(true);
    const { renderQueryRowForMember } = await import("../../src/engine/query-render.js");
    expect(renderQueryRowForMember(lost)).toContain(
      "[In reply to msg:#9999 — original not visible in this context]",
    );
  });
});
