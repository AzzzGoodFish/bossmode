/**
 * Acceptance Tests: Authentication & Server Startup (Phase 1)
 *
 * Coverage: T1.3 (login), T1.4 (token auth), T1.5 (invalid login)
 * From test plan: docs/test-plan.md §1
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, TEST_USERNAME, TEST_PASSWORD } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

setupConfigMock();

describe("Acceptance: Authentication (F2)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // T1.3: Login with correct credentials
  it("T1.3: login with correct credentials returns token + expiry", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/auth/login", {
      body: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.status).toBe(200);

    const data = JSON.parse(res.body);
    expect(data.token).toBeTruthy();
    expect(typeof data.token).toBe("string");
    expect(data.expiresAt).toBeGreaterThan(Date.now());
  });

  // T1.5: Login with wrong credentials
  it("T1.5: login with wrong password returns 401", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/auth/login", {
      body: { username: TEST_USERNAME, password: "wrongpassword" },
    });
    expect(res.status).toBe(401);
    const data = JSON.parse(res.body);
    expect(data.error).toBeTruthy();
  });

  it("T1.5: login with wrong username returns 401", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/auth/login", {
      body: { username: "nobody", password: TEST_PASSWORD },
    });
    expect(res.status).toBe(401);
  });

  it("T1.5: login with missing fields returns 400", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/auth/login", {
      body: { username: TEST_USERNAME },
    });
    expect(res.status).toBe(400);
  });

  // T1.4: Token-based auth on protected endpoints
  it("T1.4: protected endpoint without token returns 401", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/agents");
    expect(res.status).toBe(401);
  });

  it("T1.4: protected endpoint with valid token returns 200", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/agents", { token });
    expect(res.status).toBe(200);
  });

  it("T1.4: protected endpoint with invalid token returns 401", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/agents", { token: "invalid-xxx" });
    expect(res.status).toBe(401);
  });

  // CORS support
  it("CORS: OPTIONS returns proper headers", async () => {
    const res = await jsonRequest(ts.port, "OPTIONS", "/api/auth/login");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });
});
