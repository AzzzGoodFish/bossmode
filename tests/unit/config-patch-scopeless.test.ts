/**
 * qa rc.11 finding ② (superseded): the /config route is deleted
 * (design-model-switch-single-path-v1 §7); PATCH /api/members/:id is the
 * single path and has no scope concept at all.
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

describe("single-path member config PATCH", () => {
  it("/config is gone; PATCH /api/members/:id is the single path with no scope concept", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "scopeless-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;

    // The retired route is a plain 404 (design-model-switch-single-path-v1 §7).
    const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config`, {
      token,
      body: { model: "prov/m1", credentialId: "cred-1" },
    });
    expect(patched.status).toBe(404);

    const bad = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config?scope=nonsense`, {
      token,
      body: { model: "prov/m2" },
    });
    expect(bad.status).toBe(404);

    const thinking = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, { token, body: { thinkingLevel: "high" } });
    expect(thinking.status).toBe(200);
    expect(JSON.parse(thinking.body).member.global.thinkingLevel).toBe("high");
    // The picker sends null for Off; it must not silently keep the old level.
    const off = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, { token, body: { thinkingLevel: null } });
    expect(off.status).toBe(200);
    expect(JSON.parse(off.body).member.global.thinkingLevel).toBe("off");

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  });
});
