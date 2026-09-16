import { coreFixture } from "./helpers/core-fixture.js";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

// Mock the config module to avoid filesystem dependency
const testPasswordHash = (() => {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + "testpass").digest("hex");
  return `${salt}:${hash}`;
})();

vi.mock("../src/app/pid.js", () => ({
  writePidFile: () => {},
  removePidFile: () => {},
  readPidFile: () => null,
  isProcessRunning: () => false,
}));
vi.mock("../src/config/config.js", () => ({
  readConfig: () => ({
    auth: { username: "testuser", passwordHash: testPasswordHash },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
  }),
  verifyPassword: (password: string, stored: string) => {
    const { createHash, timingSafeEqual } = require("node:crypto");
    const [salt, expectedHash] = stored.split(":");
    if (!salt || !expectedHash) return false;
    const hash = createHash("sha256").update(salt + password).digest("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },
  writePidFile: () => {},
  removePidFile: () => {},
  configExists: () => true
}));

function request(
  options: http.RequestOptions & { body?: string },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          headers: res.headers,
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("HTTP server", () => {
  let fixture: ReturnType<typeof coreFixture>;
  let server: http.Server;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    fixture = coreFixture();

    // Exercise the API on a local ephemeral HTTP listener.
    const { handleApiRequest } = await import("../src/api/index.js");

    server = http.createServer(async (req, res) => {
      const handled = await handleApiRequest(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    port = (server.address() as import("node:net").AddressInfo).port;

    // Login to get token
    const loginRes = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/auth/login",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testuser", password: "testpass" }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = JSON.parse(loginRes.body);
    authToken = loginData.token;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fixture.close();
  });

  it("POST /api/auth/login with correct credentials returns token", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/auth/login",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testuser", password: "testpass" }),
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.token).toBeTruthy();
    expect(data.expiresAt).toBeGreaterThan(Date.now());
  });

  it("POST /api/auth/login with wrong credentials returns 401", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/auth/login",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testuser", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/agents requires auth", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/agents",
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/agents with token returns 404 (route retired)", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/agents",
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/rooms with token returns 200", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/rooms",
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/nonexistent returns 404", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/nonexistent",
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(404);
  });

  it("POST /internal/tool-callback is not an unauthenticated bypass", async () => {
    const unauth = await request({
      hostname: "127.0.0.1",
      port,
      path: "/internal/tool-callback",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: "room", agentName: "pm", tool: "response", args: {} }),
    });
    expect(unauth.status).toBe(401);

    const authed = await request({
      hostname: "127.0.0.1",
      port,
      path: "/internal/tool-callback",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ roomId: "room", agentName: "pm", tool: "response", args: {} }),
    });
    expect(authed.status).toBe(404);
  });

  it("OPTIONS request returns CORS headers", async () => {
    const res = await request({
      hostname: "127.0.0.1",
      port,
      path: "/api/auth/login",
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
