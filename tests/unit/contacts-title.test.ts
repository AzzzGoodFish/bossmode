import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestServer, getTestBossmodeDir, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: "testuser", password: "testpass" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("contacts + room members title chip", () => {
  it("GET /api/contacts includes frontmatter title", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "title-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    writeFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "---\nname: title-bot\ntitle: Frontend\n---\n\n## Persona\nHi.\n",
      "utf-8",
    );
    const res = await jsonRequest(ts.port, "GET", "/api/contacts", { token });
    expect(res.status).toBe(200);
    const contacts = JSON.parse(res.body).contacts as Array<{ memberId: string; title?: string | null }>;
    const hit = contacts.find((c) => c.memberId === memberId);
    expect(hit?.title).toBe("Frontend");
    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  });
});
