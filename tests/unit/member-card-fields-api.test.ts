/**
 * Member card field: title via member.md frontmatter.
 * description retired (batch-5): never written, never returned, legacy lines ignored.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

describe("member card field title (description retired)", () => {
  it("PATCH persists title to frontmatter; GET returns it; empty clears", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "card-fields-bot" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;
    expect(JSON.parse(created.body).member.title).toBeNull();
    expect(JSON.parse(created.body).member.description).toBeUndefined();

    const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "Architect" },
    });
    expect(patched.status).toBe(200);
    expect(JSON.parse(patched.body).member.title).toBe("Architect");

    const got = await jsonRequest(ts.port, "GET", `/api/members/${memberId}`, { token });
    expect(JSON.parse(got.body).member.title).toBe("Architect");
    expect(JSON.parse(got.body).member.description).toBeUndefined();

    const onDisk = readFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/title: Architect/);
    expect(onDisk).not.toMatch(/description:/);

    const cleared = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "" },
    });
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body).member.title).toBeNull();

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("description is dead end-to-end: sent description is ignored, never written or returned", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "desc-bot", description: "should not persist" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    expect(JSON.parse(created.body).member.description).toBeUndefined();

    const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { description: "still ignored" },
    });
    expect(patched.status).toBe(200);
    expect(JSON.parse(patched.body).member.description).toBeUndefined();

    const onDisk = readFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "utf-8",
    );
    expect(onDisk).not.toMatch(/description:/);

    const profile = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/profile`, { token });
    const body = JSON.parse(profile.body);
    expect(body.frontmatter.description).toBeUndefined();

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("legacy description lines in existing member.md are ignored by the parse layer", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "legacy-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "---\nname: legacy-bot\ntitle: Old\ndescription: stale blurb\n---\n\n## Persona\nBody.\n",
      "utf-8",
    );

    const got = await jsonRequest(ts.port, "GET", `/api/members/${memberId}`, { token });
    const member = JSON.parse(got.body).member;
    expect(member.title).toBe("Old");
    expect(member.description).toBeUndefined();

    // Next write drops the legacy line (write layer never emits description).
    await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "New" },
    });
    const onDisk = readFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/title: New/);
    expect(onDisk).not.toMatch(/description:/);
    expect(onDisk).toContain("## Persona");

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
});
