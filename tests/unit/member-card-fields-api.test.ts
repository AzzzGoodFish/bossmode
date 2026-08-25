/**
 * Identity batch-1 gap: PATCH/GET title+description via member.md frontmatter.
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

describe("member card fields (title/description)", () => {
  it("PATCH persists frontmatter and GET returns them; empty clears", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "card-fields-bot" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;
    expect(JSON.parse(created.body).member.title).toBeNull();
    expect(JSON.parse(created.body).member.description).toBeNull();

    const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "Architect", description: "Designs systems" },
    });
    expect(patched.status).toBe(200);
    const afterPatch = JSON.parse(patched.body).member;
    expect(afterPatch.title).toBe("Architect");
    expect(afterPatch.description).toBe("Designs systems");

    const got = await jsonRequest(ts.port, "GET", `/api/members/${memberId}`, { token });
    expect(got.status).toBe(200);
    const detail = JSON.parse(got.body).member;
    expect(detail.title).toBe("Architect");
    expect(detail.description).toBe("Designs systems");

    const onDisk = readFileSync(
      join(getTestBossmodeDir(), "members", memberId, "member.md"),
      "utf-8",
    );
    expect(onDisk).toMatch(/title: Architect/);
    expect(onDisk).toMatch(/description: Designs systems/);

    const cleared = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { title: "", description: "" },
    });
    expect(cleared.status).toBe(200);
    const afterClear = JSON.parse(cleared.body).member;
    expect(afterClear.title).toBeNull();
    expect(afterClear.description).toBeNull();

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
});
