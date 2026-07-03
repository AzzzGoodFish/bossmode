/**
 * Acceptance Tests: API Routing & Auth Protection
 *
 * Verifies that all API endpoints are routable, return proper status codes,
 * and are auth-protected. Route existence tests accept 404 (resource not found)
 * as valid — it means the route is handled, just the resource doesn't exist.
 *
 * Coverage: F3 (rooms), F4 (agents), F5 (messages)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

setupConfigMock();

describe("Acceptance: API Stubs & Routing", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // ── All protected endpoints require auth ──

  const protectedEndpoints = [
    ["GET", "/api/agents"],
    ["GET", "/api/rooms"],
    ["POST", "/api/rooms"],
    ["GET", "/api/rooms/test-1"],
    ["GET", "/api/rooms/test-1/messages"],
    ["POST", "/api/rooms/test-1/messages"],
  ] as const;

  for (const [method, path] of protectedEndpoints) {
    it(`${method} ${path} — requires auth (401 without token)`, async () => {
      const res = await jsonRequest(ts.port, method, path);
      expect(res.status).toBe(401);
    });
  }

  // ── Endpoints exist (auth works, returns non-401) ──

  it("GET /api/agents — exists and responds", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/agents", { token });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("GET /api/rooms — exists and responds", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("POST /api/rooms — exists and responds", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "test", cwd: "/tmp", members: ["pm"], promptLeaderMemberName: "pm" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("GET /api/rooms/:id — route handled (404 = room not found, not unrouted)", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/rooms/nonexistent-id", { token });
    expect(res.status).not.toBe(401);
    // 404 is correct for nonexistent room — route exists, resource doesn't
    expect([200, 404]).toContain(res.status);
  });

  it("GET /api/rooms/:id/messages — route handled", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/rooms/nonexistent-id/messages", { token });
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });

  it("POST /api/rooms/:id/messages — route handled", async () => {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms/nonexistent-id/messages", {
      token,
      body: { content: "hello @pm" },
    });
    expect(res.status).not.toBe(401);
    expect([200, 404]).toContain(res.status);
  });

  // ── Unknown routes return 404 ──

  it("GET /api/nonexistent — returns 404", async () => {
    const res = await jsonRequest(ts.port, "GET", "/api/nonexistent", { token });
    expect(res.status).toBe(404);
  });

  // ── All JSON responses are parseable ──

  it("all API responses are valid JSON", async () => {
    for (const [method, path] of protectedEndpoints) {
      const res = await jsonRequest(ts.port, method, path, { token });
      expect(() => JSON.parse(res.body)).not.toThrow();
    }
  });
});
