import { createMember, findMemberByName } from "../../src/member/member-registry.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestServer, createTestServer, getTestBossmodeDir, httpRequest, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

async function uploadText(port: number, roomId: string, token: string, filename: string, body: string) {
  const res = await httpRequest({
    hostname: "127.0.0.1",
    port,
    method: "POST",
    path: `/api/rooms/${roomId}/upload?filename=${encodeURIComponent(filename)}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as { filename: string; originalFilename: string; path: string; size: number; url: string; previewType: string };
}

describe("chat attachment artifacts", () => {
  const servers: Awaited<ReturnType<typeof createTestServer>>[] = [];

  afterEach(async () => {
    while (servers.length) await closeTestServer(servers.pop()!);
  });

  it("stores user uploads as structured message attachments without absolute paths and previews markdown", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const token = await login(ts.port);
    const roomStore = await import("../../src/chat/room-store.js");

    const cwd = mkdtempSync(join(tmpdir(), "bossmode-chat-attach-"));
    const room = roomStore.createRoom("Attachments", cwd, [(findMemberByName("pm") ?? createMember({ name: "pm" })).id]);

    const uploaded = await uploadText(ts.port, room.id, token, "note.md", "# Note\n\nBody");
    expect(uploaded.previewType).toBe("markdown");
    expect(uploaded.path).toBe(uploaded.filename);
    expect(uploaded.path).not.toContain(cwd);
    expect(uploaded.path).not.toMatch(/^\//);

    const posted = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token,
      body: {
        content: "see attachment",
        attachments: [{ storedFilename: uploaded.filename, originalFilename: uploaded.originalFilename, size: uploaded.size }],
      },
    });
    expect(posted.status).toBe(200);
    const messageJson = posted.body;
    expect(messageJson).not.toContain(cwd);
    expect(messageJson).not.toContain("Attachment: [original filename:");
    const message = JSON.parse(messageJson);
    expect(message.content).toBe("see attachment");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        storedFilename: uploaded.filename,
        originalFilename: "note.md",
        previewType: "markdown",
      }),
    ]);

    const preview = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/attachments/${uploaded.filename}/preview`, { token });
    expect(preview.status).toBe(200);
    const previewBody = JSON.parse(preview.body);
    expect(previewBody.type).toBe("md");
    expect(previewBody.content).toContain("# Note");

    const unsafe = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/attachments/${encodeURIComponent("../note.md")}/preview`, { token });
    expect(unsafe.status).not.toBe(200);
  });

  it("agent chat rejects an empty message (designer incident 2026-09-04)", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const roomStore = await import("../../src/chat/room-store.js");
    const messageStore = await import("../../src/chat/message-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("Empty Chat", undefined, [(findMemberByName("developer") ?? createMember({ name: "developer" })).id]);

    const rejected = await handleToolCallback("chat_send", room.id, "developer", {
      message: "",
    }) as any;
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("non-empty");

    const whitespace = await handleToolCallback("chat_send", room.id, "developer", {
      message: "   \n\t  ",
    }) as any;
    expect(whitespace.ok).toBe(false);

    // Nothing was posted for either attempt.
    expect(messageStore.getMessages(room.id, { limit: 10 })).toHaveLength(0);

    // Non-empty text still works.
    const ok = await handleToolCallback("chat_send", room.id, "developer", {
      message: "real message",
    }) as any;
    expect(ok.ok).toBe(true);
    expect(messageStore.getMessages(room.id, { limit: 10 })).toHaveLength(1);
  });

  it("agent chat fails atomically when any attachment path is missing", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const roomStore = await import("../../src/chat/room-store.js");
    const messageStore = await import("../../src/chat/message-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");

    const cwd = mkdtempSync(join(tmpdir(), "bossmode-agent-attach-missing-"));
    const missingPath = join(cwd, "missing.md");
    const room = roomStore.createRoom("Agent Missing Attach", cwd, [(findMemberByName("developer") ?? createMember({ name: "developer" })).id]);

    const result = await handleToolCallback("chat_send", room.id, "developer", {
      message: "should not send",
      attachments: [missingPath],
    }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain(missingPath);
    expect(messageStore.getMessages(room.id, { limit: 10 })).toHaveLength(0);

    const caller = findMemberByName("developer")!;
    roomStore.stampGlobalMemberIds(room.id, [caller.id]);
    const chatTool = createBossmodeSdkTools({ roomId: room.id, memberId: caller.id })[0];
    await expect(chatTool.execute("call-1", {
      message: "should not report sent",
      attachments: [missingPath],
    })).rejects.toThrow(missingPath);
    expect(messageStore.getMessages(room.id, { limit: 10 })).toHaveLength(0);
  });

  it("agent chat attachments use structured metadata and do not leak source/store absolute paths in message JSON", async () => {
    const ts = await createTestServer();
    servers.push(ts);
    const roomStore = await import("../../src/chat/room-store.js");
    const messageStore = await import("../../src/chat/message-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const cwd = mkdtempSync(join(tmpdir(), "bossmode-agent-attach-"));
    const sourcePath = join(cwd, "agent-note.html");
    writeFileSync(sourcePath, "<h1>Agent Note</h1>", "utf8");
    const room = roomStore.createRoom("Agent Attach", cwd, [(findMemberByName("developer") ?? createMember({ name: "developer" })).id]);

    const result = await handleToolCallback("chat_send", room.id, "developer", {
      message: "attached",
      attachments: [sourcePath],
    }) as any;
    expect(result.ok).toBe(true);

    const [message] = messageStore.getMessages(room.id, { limit: 1 });
    const serialized = JSON.stringify(message);
    expect(message.content).toBe("attached");
    expect(serialized).not.toContain(sourcePath);
    expect(serialized).not.toContain(cwd);
    expect(serialized).not.toContain(".bossmode-attachments");
    expect(message.attachments?.[0]).toEqual(expect.objectContaining({
      originalFilename: "agent-note.html",
      previewType: "html",
    }));
    expect(message.attachments?.[0].storedFilename).toMatch(/^[a-f0-9]{12}\.html$/);
    expect(message.attachments?.[0].storedFilename).not.toContain("/");

    // Test mock config path is isolated and not serialized accidentally.
    expect(serialized).not.toContain(getTestBossmodeDir());
  });
});
