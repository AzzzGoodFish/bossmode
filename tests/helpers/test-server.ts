import { loadMemberPromptSource, loadAgentMemberSnapshot } from "../../src/app/member-actions.js";

/** Real HTTP/WS routes with explicit SQL fixtures; only model execution is mocked. */
import { beforeAll, afterAll } from "vitest";
import http from "node:http";
import { coreFixture } from "./core-fixture.js";
import type { Room } from "../../src/kernel/types.js";

const TEST_PASSWORD = "testpass";
const TEST_USERNAME = "testuser";
const TEST_BOSSMODE_DIR = process.env.BOSSMODE_DIR;
if (!process.env.BOSSMODE_TEST_ROOT || !TEST_BOSSMODE_DIR) throw new Error("HTTP fixtures require the isolated npm test launcher");
const servers = new Set<TestServer>();
let storage: ReturnType<typeof coreFixture>;
let stopProfiles: (() => void) | undefined;
let stopConfigPatches: (() => void) | undefined;
export function getTestBossmodeDir(): string { return TEST_BOSSMODE_DIR!; }
export function getTestWorkspace() {
  if (!storage) throw new Error("Test workspace has not been initialized");
  return storage;
}

/** Opt-in suite lifecycle, not a global import-time DB initializer. Real password/config APIs are retained. */
export function setupTestWorkspace(): void {
  beforeAll(async () => {
    storage = coreFixture(TEST_BOSSMODE_DIR);
    stopProfiles = (await import("../../src/app/wire.js")).wireMemberProfiles();
    stopConfigPatches = (await import("../../src/app/wire.js")).wireMemberConfigPatches();
    const { getDefaultConfig, writeConfig } = await import("../../src/config/settings.js");
    const { hashPassword } = await import("../../src/api/auth.js");
    writeConfig({ ...getDefaultConfig(), auth: { username: TEST_USERNAME, passwordHash: hashPassword(TEST_PASSWORD) } });
  });
  afterAll(async () => {
    stopProfiles?.();
    stopConfigPatches?.();
    const errors: unknown[] = [];
    for (const server of [...servers]) try { await closeTestServer(server); } catch (error) { errors.push(error); }
    try { const { shutdownAll } = await ({ ...await import("../../src/app/member-actions.js"), ...await import("../../src/agent/controls.js"), ...await import("../../src/agent/assembly.js"), ...await import("../../src/agent/instance.js"), ...await import("../../src/agent/scheduler.js") }); await shutdownAll(); } catch (error) { errors.push(error); }
    try { storage?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "HTTP fixture cleanup failed");
  });
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
    const requestOptions = options.body === undefined ? options : { ...options, headers: { ...options.headers, "Content-Length": Buffer.byteLength(options.body) } };
    const req = http.request(requestOptions, (res) => {
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
  stopRouter: () => void;
  stopAgentEvents: () => void;
}

export async function createTestServer(): Promise<TestServer> {
  const { getDatabase } = await import("../../src/data/database.js");
  getDatabase(); // The caller must explicitly bootstrap storage before service consumers.
  const { handleApiRequest } = await import("../../src/api/http.js");
  const { createWebSocketServer } = await import("../../src/app/ws.js");
  const { initializeMemberRuntime } = await import("../../src/app/member-actions.js");
  const { RuntimeRegistry } = await import("../../src/agent/types.js");
  const { MockRuntime } = await import("./mock-runtime.js");

  // Initialize mock runtime for tests
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime());
  registry.register(new MockRuntime("pi-cli"));
  initializeMemberRuntime(registry, loadMemberPromptSource, loadAgentMemberSnapshot);

  const wiring = await import("../../src/app/wire.js");
  await wiring.wireApiRoutes();
  const stopChat = wiring.wireChatHttp();
  const stopMemberHttp = wiring.wireMemberHttp();
  const stopRouter = () => { stopChat(); stopMemberHttp(); };
  // Same output wiring as production — agent facts reach WS and chat on one code path.
  const stopAgentEvents = wiring.wireAgentEvents();

  const server = http.createServer(async (req, res) => {
    try {
      if (!await handleApiRequest(req, res)) { res.writeHead(404); res.end("Not found"); }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  createWebSocketServer(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const result = { server, stopRouter, stopAgentEvents, port, url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
  servers.add(result);
  return result;
}

export async function closeTestServer(ts: TestServer): Promise<void> {
  ts.stopRouter();
  ts.stopAgentEvents();
  const { shutdownWebSocket } = await import("../../src/app/ws.js");
  await shutdownWebSocket();
  const { shutdownAll } = await ({ ...await import("../../src/app/member-actions.js"), ...await import("../../src/agent/controls.js"), ...await import("../../src/agent/assembly.js"), ...await import("../../src/agent/instance.js"), ...await import("../../src/agent/scheduler.js") });
  await shutdownAll();
  ts.server.closeAllConnections();
  if (ts.server.listening) await new Promise<void>((resolve, reject) => ts.server.close(error => error ? reject(error) : resolve()));
  servers.delete(ts);
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
// tests configure current global members through the registry with a stable
// test-only pair. The mock runtime never executes a real provider request.
export const MOCK_MEMBER_MODEL = "mock-provider/mock-model";
export const MOCK_MEMBER_CREDENTIAL_ID = "test-credential";

export async function configureMockMemberModel(roomId: string, memberRef: string): Promise<void> {
  const roomStore = await import("../../src/chat/conversations.js");
  const registry = await import("../../src/member/identity.js");
  const member = registry.getMember(memberRef) || registry.getMember(roomStore.findRoomMemberByName(roomId, memberRef)?.id || "");
  if (!member) throw new Error("Mock execution requires a current global member; create the room with memberIds");
  if (member.global.model !== MOCK_MEMBER_MODEL || member.global.credentialId !== MOCK_MEMBER_CREDENTIAL_ID) {
    registry.updateMember(member.id, { global: { ...member.global, model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
  }
}

/** Creates current global identities and uses the actual memberIds room API, never the retired local draft path. */
export async function createMockRoom(port: number, token: string, name: string, names: string[]): Promise<Room> {
  const listed = await jsonRequest(port, "GET", "/api/members", { token });
  if (listed.status !== 200) throw new Error(`Cannot list fixture members: ${listed.status} ${listed.body}`);
  const existing = JSON.parse(listed.body).members as Array<{ memberId: string; name: string }>;
  const memberIds: string[] = [];
  for (const memberName of names) {
    let member = existing.find(candidate => candidate.name === memberName);
    if (!member) {
      const created = await jsonRequest(port, "POST", "/api/members", { token, body: {
        name: memberName, model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID,
      } });
      if (created.status !== 200) throw new Error(`Cannot create fixture member: ${created.status} ${created.body}`);
      member = JSON.parse(created.body).member;
      if (!member || typeof member.memberId !== "string") throw new Error("Invalid fixture member response");
      existing.push(member);
    }
    if (typeof member.memberId !== "string") throw new Error("Invalid fixture member identity");
    memberIds.push(member.memberId);
  }
  const response = await jsonRequest(port, "POST", "/api/rooms", { token, body: { name, memberIds, leaderMemberId: memberIds[0] } });
  if (response.status !== 200) throw new Error(`Cannot create fixture room: ${response.status} ${response.body}`);
  const room = JSON.parse(response.body) as Room;
  await configureMockMembersForRoom(room.id, memberIds);
  return room;
}

export async function configureMockMembersForRoom(roomId: string, memberRefs: string[]): Promise<void> {
  for (const ref of memberRefs) await configureMockMemberModel(roomId, ref);
}
