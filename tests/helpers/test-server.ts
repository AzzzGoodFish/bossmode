/**
 * Test server helper — spins up a real HTTP + WS server for acceptance tests.
 * Uses mock config to avoid filesystem dependency.
 */
import { vi } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ── Mock config (must be called before importing server modules) ──

const TEST_PASSWORD = "testpass";
const TEST_USERNAME = "testuser";

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

const testPasswordHash = hashPassword(TEST_PASSWORD);

export function setupConfigMock(): void {
  vi.mock("../../src/store/config.js", () => ({
    readConfig: () => ({
      auth: { username: TEST_USERNAME, passwordHash: testPasswordHash },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
    }),
    verifyPassword: (password: string, stored: string) => {
      const [salt, expectedHash] = stored.split(":");
      if (!salt || !expectedHash) return false;
      const hash = createHash("sha256").update(salt + password).digest("hex");
      const a = Buffer.from(hash, "hex");
      const b = Buffer.from(expectedHash, "hex");
      if (a.length !== b.length) return false;
      return require("node:crypto").timingSafeEqual(a, b);
    },
    ensureBossmodeDir: () => {},
    writePidFile: () => {},
    removePidFile: () => {},
    configExists: () => true,
    getBossmodeDir: () => "/tmp/bossmode-test",
  }));
}

// ── HTTP client ──

export interface HttpResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export function httpRequest(
  options: http.RequestOptions & { body?: string },
): Promise<HttpResponse> {
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

export function jsonRequest(
  port: number,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
): Promise<HttpResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;

  return httpRequest({
    hostname: "127.0.0.1",
    port,
    path,
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ── Server lifecycle ──

export interface TestServer {
  server: http.Server;
  port: number;
  url: string;
  wsUrl: string;
}

export async function createTestServer(): Promise<TestServer> {
  const { handleApiRequest } = await import("../../src/server/api.js");
  const { createWebSocketServer } = await import("../../src/server/ws.js");
  const { initAgentManager } = await import("../../src/core/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/core/runtime/registry.js");
  const { MockRuntime } = await import("./mock-runtime.js");

  // Initialize mock runtime for tests
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime());
  initAgentManager(registry);

  const port = 10000 + Math.floor(Math.random() * 50000);
  const server = http.createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  createWebSocketServer(server);

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
}

export async function closeTestServer(ts: TestServer): Promise<void> {
  const { shutdownWebSocket } = await import("../../src/server/ws.js");
  shutdownWebSocket();
  await new Promise<void>((resolve) => ts.server.close(() => resolve()));
}

// ── Auth helper ──

export async function loginAndGetToken(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body).token;
}

export { TEST_USERNAME, TEST_PASSWORD };
