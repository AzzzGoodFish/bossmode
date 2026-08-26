/**
 * Designer contract: GET /api/members/:id/profile + /skills
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("member profile + skills panel APIs", () => {
  it("GET profile returns frontmatter, body, charCount, overBudget", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "profile-bot" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;

    await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "Dev", description: "Ships code" },
    });

    const root = getTestBossmodeDir();
    writeFileSync(
      join(root, "members", memberId, "member.md"),
      "---\nname: profile-bot\ntitle: Dev\ndescription: Ships code\n---\n\n## Persona\nI write tests first.\n",
      "utf-8",
    );

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/profile`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.path).toContain(`members/${memberId}/member.md`);
    expect(body.frontmatter).toEqual({ name: "profile-bot", title: "Dev", description: "Ships code" });
    expect(body.body).toContain("## Persona");
    expect(typeof body.charCount).toBe("number");
    expect(body.overBudget).toBe(false);
    expect(body.exists).toBe(true);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  });

  it("GET skills lists SKILL.md entries via catalog scan", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "skill-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    const skillDir = join(getTestBossmodeDir(), "members", memberId, "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Review pull requests carefully\n---\n\nDo thorough reviews.\n",
      "utf-8",
    );

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/skills`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.skills.some((s: { name: string; platform?: boolean }) => s.name === "bossmode-guide" && s.platform === true)).toBe(true);
    expect(body.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          path: "review/SKILL.md",
          description: "Review pull requests carefully",
          platform: false,
        }),
      ]),
    );

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  });
});
