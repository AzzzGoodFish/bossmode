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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-process unique dir — a fixed "/tmp/bossmode-test" collides across users
// on shared machines (EACCES on files owned by another user) and across runs.
const TEST_BOSSMODE_DIR = mkdtempSync(join(tmpdir(), "bossmode-test-"));
mkdirSync(join(TEST_BOSSMODE_DIR, "agents"), { recursive: true });
for (const agent of ["pm", "qa", "architect", "developer"]) {
  writeFileSync(join(TEST_BOSSMODE_DIR, "agents", `${agent}.md`), `---\nname: ${agent}\nskills: []\ntags: []\n---\n${agent}`, "utf8");
}

/** The BOSSMODE_DIR used by the mocked config — tests that build fixture paths must use this. */
export function getTestBossmodeDir(): string {
  return TEST_BOSSMODE_DIR;
}

export function setupConfigMock(): void {
  vi.mock("../../src/shared/config.js", () => ({
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
    getBossmodeDir: () => TEST_BOSSMODE_DIR,
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
  const { handleApiRequest } = await import("../../src/api/index.js");
  const { createWebSocketServer } = await import("../../src/communication/ws.js");
  const { initAgentManager, activateAgent, activateAll, interruptAgent } = await import("../../src/engine/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/engine/runtime/registry.js");
  const { initRouter } = await import("../../src/communication/router.js");
  const { MockRuntime } = await import("./mock-runtime.js");

  // Initialize mock runtime for tests
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime());
  registry.register(new MockRuntime("pi-cli"));
  initAgentManager(registry);

  // Initialize message router — wire @mentions to engine
  initRouter(
    (roomId, memberName, ctx) => { activateAgent(roomId, memberName, ctx).catch(() => {}); },
    (roomId, ctx) => { activateAll(roomId, ctx).catch(() => {}); },
    (roomId, memberRef, urgentByName) => { interruptAgent(roomId, memberRef, urgentByName).catch(() => {}); },
  );

  const server = http.createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  createWebSocketServer(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
}

export async function closeTestServer(ts: TestServer): Promise<void> {
  const { shutdownWebSocket } = await import("../../src/communication/ws.js");
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

// ── Test-only member configuration ──
// The activation gate now requires every member to have an explicit
// {model, credentialId} pair before it can be activated. Acceptance tests use
// the mock runtime, which never talks to the real model-credentials engine, so
// tests configure members directly through the room store (bypassing the HTTP
// route's real-credential availability check) with a stable test-only pair.
export const MOCK_MEMBER_MODEL = "mock-provider/mock-model";
export const MOCK_MEMBER_CREDENTIAL_ID = "test-credential";

export async function configureMockMemberModel(roomId: string, memberRef: string): Promise<void> {
  const roomStore = await import("../../src/workspace/room-store.js");
  roomStore.updateRoomMemberOverride(roomId, memberRef, { model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID });
}

export async function configureMockMembersForRoom(roomId: string, memberRefs: string[]): Promise<void> {
  for (const ref of memberRefs) await configureMockMemberModel(roomId, ref);
}
