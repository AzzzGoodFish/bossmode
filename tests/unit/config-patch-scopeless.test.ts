/**
 * qa rc.11 finding ②: PATCH /api/members/:id/config without ?scope= must not 400.
 */
import { describe, expect, it } from "vitest";
import { createTestServer, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: "testuser", password: "testpass" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("scopeless config PATCH", () => {
  it("missing scope defaults to the member's DM scope (no 400)", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "scopeless-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;

    const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config`, {
      token,
      body: { model: "prov/m1", credentialId: "cred-1" },
    });
    expect(patched.status).toBe(200);
    const body = JSON.parse(patched.body);
    expect(body.member.global.model).toBe("prov/m1");
    expect(body.effective.model).toBe("prov/m1");

    const bad = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config?scope=nonsense`, {
      token,
      body: { model: "prov/m2" },
    });
    expect(bad.status).toBe(400);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  });
});
