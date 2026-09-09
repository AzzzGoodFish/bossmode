import { afterAll, beforeAll, expect, it } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, httpRequest, TEST_USERNAME, TEST_PASSWORD, type TestServer } from "../helpers/test-server.js";
setupTestWorkspace();
let server: TestServer;
beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { if (server) await closeTestServer(server); });

it("issues a real SQL-backed login token and accepts it on protected routes", async () => {
  const response = await jsonRequest(server.port, "POST", "/api/auth/login", { body: { username: TEST_USERNAME, password: TEST_PASSWORD } });
  expect(response.status).toBe(200);
  const session = JSON.parse(response.body);
  expect(typeof session.token).toBe("string");
  expect(session.token.length).toBeGreaterThan(0);
  expect(session.expiresAt).toBeGreaterThan(Date.now());
  expect((await jsonRequest(server.port, "GET", "/api/rooms", { token: session.token })).status).toBe(200);
});

it("rejects invalid credentials and missing, invalid or non-Bearer authorization", async () => {
  for (const [body, status] of [
    [{ username: TEST_USERNAME, password: "wrong" }, 401],
    [{ username: "missing", password: TEST_PASSWORD }, 401],
    [{ username: TEST_USERNAME }, 400],
  ] as const) {
    const response = await jsonRequest(server.port, "POST", "/api/auth/login", { body });
    expect(response.status, response.body).toBe(status);
    expect(JSON.parse(response.body).error).toBeTruthy();
  }
  for (const authorization of [undefined, "Bearer invalid", "Basic invalid"]) {
    const response = await httpRequest({ hostname: "127.0.0.1", port: server.port, method: "GET", path: "/api/rooms", headers: authorization ? { authorization } : {} });
    expect(response.status).toBe(401);
  }
});

it("allows unauthenticated CORS preflight without exposing protected data", async () => {
  const response = await jsonRequest(server.port, "OPTIONS", "/api/auth/login");
  expect(response.status).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe("*");
  expect(response.headers["access-control-allow-methods"]).toContain("POST");
});
