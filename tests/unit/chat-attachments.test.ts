import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestServer, createTestServer, getTestBossmodeDir, httpRequest, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

setupConfigMock();

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
    const roomStore = await import("../../src/workspace/room-store.js");

    const cwd = mkdtempSync(join(tmpdir(), "bossmode-chat-attach-"));
    const room = roomStore.createRoom("Attachments", cwd, drafts(["pm"]));

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

});
