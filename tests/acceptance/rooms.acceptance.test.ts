import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, getTestWorkspace, jsonRequest, loginAndGetToken, type TestServer } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import { resetMocks, mockPromptFn, mockCompactFn } from "../helpers/mock-runtime.js";
setupTestWorkspace();
let server: TestServer, token: string;
beforeAll(async () => { server = await createTestServer(); token = await loginAndGetToken(server.port); });
afterAll(async () => { if (server) await closeTestServer(server); });
beforeEach(() => { resetMocks(); vi.clearAllMocks(); });
const request = (method: string, path: string, body?: unknown) => jsonRequest(server.port, method, path, { token, body });

it("creates, lists and edits rooms using stable global membership, including an empty roster", async () => {
  const room = await createMockRoom(server.port, token, "Room workflow", ["pm", "architect"]);
  expect(room.members).toEqual(["pm", "architect"]);
  expect(room.globalMemberIds).toHaveLength(2);
  const detail = await request("GET", `/api/rooms/${room.id}`);
  expect(detail.status).toBe(200);
  expect(JSON.parse(detail.body).globalMemberIds).toEqual(room.globalMemberIds);
  const patch = await request("PATCH", `/api/rooms/${room.id}`, { name: "Renamed", ruleDocs: ["rules/team.md"], docsPath: "project/docs", promptLeaderMemberId: room.globalMemberIds![1] });
  expect(patch.status, patch.body).toBe(200);
  expect(JSON.parse(patch.body)).toMatchObject({ name: "Renamed", ruleDocs: ["rules/team.md"], docsPath: "project/docs/", promptLeaderMemberId: room.globalMemberIds![1] });
  const listed = await request("GET", "/api/rooms");
  expect(listed.status).toBe(200);
  expect(JSON.parse(listed.body)).toContainEqual(expect.objectContaining({ id: room.id, name: "Renamed" }));
  const empty = await request("POST", "/api/rooms", { name: "Empty", memberIds: [] });
  expect(empty.status, empty.body).toBe(200);
  expect(JSON.parse(empty.body)).toMatchObject({ members: [], globalMemberIds: [] });
});

it("rejects invalid creation and member-global fields on room patches", async () => {
  const room = await createMockRoom(server.port, token, "Validation", ["pm"]);
  for (const body of [
    { memberIds: [] },
    { name: "Unknown member", memberIds: ["mem_missing"] },
    { name: "Wrong leader", memberIds: room.globalMemberIds, leaderMemberId: "mem_outside" },
  ]) expect((await request("POST", "/api/rooms", body)).status).toBe(400);
  expect((await request("GET", "/api/rooms/missing")).status).toBe(404);
  const cwd = await request("PATCH", `/api/rooms/${room.id}`, { cwd: "/retired" });
  expect(cwd.status).toBe(400);
  expect(JSON.parse(cwd.body).error).toContain("Nothing to update");
  const model = await request("PATCH", `/api/rooms/${room.id}/members/${room.globalMemberIds![0]}`, { thinkingLevel: "max" });
  expect(model.status).toBe(400);
  expect(JSON.parse(model.body).error).toBe("model_config_is_global");
});

it("reports an actual SQL read failure instead of an empty successful room list, then recovers", async () => {
  const room = await createMockRoom(server.port, token, "Read failure", ["pm"]);
  const db = getTestWorkspace().db;
  db.exec("ALTER TABLE rooms RENAME TO unavailable_rooms");
  try {
    const response = await request("GET", "/api/rooms");
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body).error).toBe("Couldn’t load Rooms");
  } finally { db.exec("ALTER TABLE unavailable_rooms RENAME TO rooms"); }
  const recovered = await request("GET", "/api/rooms");
  expect(recovered.status).toBe(200);
  expect(JSON.parse(recovered.body)).toContainEqual(expect.objectContaining({ id: room.id }));
});

it("persists a user message and delivers it to both subscribed clients without mixing rooms", async () => {
  const room = await createMockRoom(server.port, token, "Delivery", ["pm"]);
  const other = await createMockRoom(server.port, token, "Other delivery", ["architect"]);
  const clients = await Promise.all([createWsClient(server.wsUrl, token), createWsClient(server.wsUrl, token)]);
  try {
    clients.forEach(client => client.send({ type: "subscribe:room", roomId: room.id }));
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = await request("POST", `/api/rooms/${room.id}/messages`, { content: "hello everyone" });
    expect(response.status).toBe(200);
    const message = JSON.parse(response.body);
    expect(message).toMatchObject({ sender: "user", content: "hello everyone" });
    expect(message.id).toBeTruthy(); expect(message.ts).toBeGreaterThan(0);
    const received = await Promise.all(clients.map(client => client.waitFor(event => event.type === "room:message" && event.message.id === message.id)));
    received.forEach(event => expect(event).toMatchObject({ type: "room:message", message }));
    const history = await request("GET", `/api/rooms/${room.id}/messages`);
    expect(history.status).toBe(200);
    expect(JSON.parse(history.body)).toContainEqual(message);
    expect(JSON.parse((await request("GET", `/api/rooms/${other.id}/messages`)).body)).toEqual([]);
  } finally { await Promise.all(clients.map(client => client.close())); }
});

it("executes explicit and single-member compact commands without a normal model prompt", async () => {
  for (const content of ["@pm /compact", "/compact"]) {
    resetMocks();
    const room = await createMockRoom(server.port, token, `Compact ${content}`, ["pm"]);
    const response = await request("POST", `/api/rooms/${room.id}/messages`, { content });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).content).toBe(content);
    await vi.waitFor(() => expect(mockCompactFn).toHaveBeenCalledTimes(1));
    expect(mockPromptFn).not.toHaveBeenCalled();
  }
});
