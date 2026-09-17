/**
 * DM attachment download serves bytes WITHOUT an Authorization header (browser
 * <img>/<a> can't send one) — the auth bypass must cover /api/dm/.../attachments/
 * (0.20 rc.5: the bypass regex only covered /api/rooms/, so DM bytes were 401).
 * Control: a normal API route stays 401 without a token.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, loginAndGetToken, getTestBossmodeDir, type TestServer } from "../helpers/test-server.js";

setupTestWorkspace();

let ts: TestServer;
let token: string;
let downloadUrl = "";
const BYTES = "DM-IMG-BYTES-0123456789";

beforeAll(async () => {
  ts = await createTestServer();
  token = await loginAndGetToken(ts.port);
  const reg = await import("../../src/member/identity.js"), __reg_app_member_actions = await import("../../src/app/member-actions.js");
  const member = __reg_app_member_actions.createMember({ name: "att-dm", agentTemplate: "general" });

  const up = await fetch(`http://127.0.0.1:${ts.port}/api/dm/${member.id}/upload?filename=${encodeURIComponent("pic.png")}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: BYTES,
  });
  expect(up.status).toBe(200);
  const body = (await up.json()) as { url: string };
  downloadUrl = body.url;
  expect(downloadUrl).toContain(`/api/dm/${member.id}/attachments/`);
}, 30_000);

afterAll(async () => {
  await closeTestServer(ts);
});

describe("DM attachment download auth bypass", () => {
  it("GET without Authorization returns 200 and the exact bytes", async () => {
    const res = await fetch(`http://127.0.0.1:${ts.port}${downloadUrl}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BYTES);
  });

  it("control: a normal API route without Authorization stays 401", async () => {
    const res = await fetch(`http://127.0.0.1:${ts.port}/api/chats`);
    expect(res.status).toBe(401);
  });

  it("traversal attempt is rejected (400/404, never escapes the member dir)", async () => {
    const res = await fetch(`http://127.0.0.1:${ts.port}/api/dm/mem_fake/attachments/..%2F..%2Fconfig.json`);
    expect([400, 404]).toContain(res.status);
  });
});
