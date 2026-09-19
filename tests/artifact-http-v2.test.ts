import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addEntry } from "../src/knowledge/documents.js";
import {
  closeTestServer,
  createTestServer,
  getTestBossmodeDir,
  jsonRequest,
  setupTestWorkspace,
} from "./helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const response = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: "testuser", password: "testpass" },
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body).token;
}

describe("canonical artifact HTTP routes", () => {
  const servers: Awaited<ReturnType<typeof createTestServer>>[] = [];
  afterEach(async () => { while (servers.length) await closeTestServer(servers.pop()!); });

  it("previews and streams knowledge and member-root artifacts", async () => {
    const server = await createTestServer(); servers.push(server);
    const token = await login(server.port);
    const created = await jsonRequest(server.port, "POST", "/api/members", { token, body: { name: "artifact-owner" } });
    const memberId = JSON.parse(created.body).member.memberId as string;
    const roomResponse = await jsonRequest(server.port, "POST", "/api/rooms", {
      token, body: { name: "Artifacts", memberIds: [memberId], leaderMemberId: memberId },
    });
    const roomId = JSON.parse(roomResponse.body).id as string;

    addEntry("Plan", "# Plan\n\nBody", "test", "project/plan.md");
    const directory = join(getTestBossmodeDir(), "members", memberId, "prototype");
    mkdirSync(directory, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    writeFileSync(join(directory, "demo.png"), png);

    const markdown = await jsonRequest(server.port, "GET",
      `/api/rooms/${roomId}/artifact-preview?path=${encodeURIComponent("docs/project/plan.md")}`, { token });
    expect(markdown.status).toBe(200);
    expect(JSON.parse(markdown.body)).toMatchObject({
      type: "md", originalPath: "docs/project/plan.md", path: "project/plan.md", title: "Plan", content: "# Plan\n\nBody",
    });

    const preview = await jsonRequest(server.port, "GET",
      `/api/rooms/${roomId}/artifact-preview?path=${encodeURIComponent("prototype/demo.png")}`, { token });
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.body)).toMatchObject({ type: "image", originalPath: "prototype/demo.png" });
    expect(JSON.parse(preview.body).content).toMatch(/^data:image\/png;base64,/);

    const raw = await fetch(`http://127.0.0.1:${server.port}/api/rooms/${roomId}/artifact-raw?path=${encodeURIComponent("prototype/demo.png")}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await raw.arrayBuffer()).equals(png)).toBe(true);
  });

  it("returns a stable not-found error without leaking candidate paths", async () => {
    const server = await createTestServer(); servers.push(server);
    const token = await login(server.port);
    const room = await jsonRequest(server.port, "POST", "/api/rooms", { token, body: { name: "Empty", memberIds: [] } });
    const roomId = JSON.parse(room.body).id as string;
    const response = await jsonRequest(server.port, "GET",
      `/api/rooms/${roomId}/artifact-preview?path=${encodeURIComponent("docs/missing.md")}`, { token });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "Artifact not found: docs/missing.md" });
  });
});
