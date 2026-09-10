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

it("reuses exact contact identities across rooms without cloning or renaming display names", async () => {
  const names = ["言实 team", "review `quoted`", "mem_display_only"];
  const ids: string[] = [];
  for (const name of names) {
    const created = await request("POST", "/api/members", { name });
    expect(created.status, created.body).toBe(200);
    expect(JSON.parse(created.body).member.name).toBe(name);
    ids.push(JSON.parse(created.body).member.memberId);
  }
  const before = await request("GET", "/api/members");
  expect(before.status).toBe(200);
  for (const name of ["Shared contacts A", "Shared contacts B"]) {
    const created = await request("POST", "/api/rooms", { name, memberIds: [...ids, ids[0]], leaderMemberId: ids[1] });
    expect(created.status, created.body).toBe(200);
    const room = JSON.parse(created.body);
    expect(room).toMatchObject({ members: names, globalMemberIds: ids, promptLeaderMemberId: ids[1] });
    const detail = await request("GET", `/api/rooms/${room.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.body)).toMatchObject({ members: names, globalMemberIds: ids, promptLeaderMemberId: ids[1] });
  }
  const after = await request("GET", "/api/members");
  expect(after.status).toBe(200);
  expect(JSON.parse(after.body)).toEqual(JSON.parse(before.body));
});

it("rejects room drafts, names and coerced IDs atomically; valid selected IDs still work after rejection", async () => {
  const fixture = await createMockRoom(server.port, token, "Contact validation fixture", ["validation-contact"]);
  const id = fixture.globalMemberIds![0];
  const before = await request("GET", "/api/rooms");
  const contactsBefore = await request("GET", "/api/members");
  for (const fields of [
    { members: [{ agent: "pm", name: "draft-contact" }] },
    { memberIds: [id], members: [] },
    { memberIds: [id], promptLeaderMemberName: "validation-contact" },
    { memberIds: ["validation-contact"] },
    { memberIds: ["mem_display_only"] },
    { memberIds: [17] },
    { memberIds: [null] },
    { memberIds: [{ memberId: id }] },
    { memberIds: [` ${id}`] },
    { memberIds: [id], leaderMemberId: "validation-contact" },
    { memberIds: [id], leaderMemberId: 17 },
  ]) {
    const rejected = await request("POST", "/api/rooms", { name: "Rejected draft", ...fields });
    expect(rejected.status, rejected.body).toBe(400);
  }
  expect(JSON.parse((await request("GET", "/api/rooms")).body)).toEqual(JSON.parse(before.body));
  expect(JSON.parse((await request("GET", "/api/members")).body)).toEqual(JSON.parse(contactsBefore.body));
  const retried = await request("POST", "/api/rooms", { name: "Corrected selection", memberIds: [id], leaderMemberId: id });
  expect(retried.status, retried.body).toBe(200);
  expect(JSON.parse(retried.body)).toMatchObject({ globalMemberIds: [id], promptLeaderMemberId: id });
});

it("invites only actual contact IDs and rejects deleted contacts without creating replacements", async () => {
  const room = await createMockRoom(server.port, token, "Contact invitations", []);
  const created = await request("POST", "/api/members", { name: "invitation-contact" });
  expect(created.status).toBe(200);
  const id = JSON.parse(created.body).member.memberId;
  for (const [body, status] of [
    [{ agent: "pm", name: "draft-invite" }, 400],
    [{ memberId: id, agent: "pm" }, 400],
    [{ memberId: id, name: "alias" }, 400],
    [{ memberId: "invitation-contact" }, 404],
    [{ memberId: 17 }, 400],
    [{ memberId: [id] }, 400],
    [{ memberId: ` ${id}` }, 400],
  ] as const) {
    const rejected = await request("POST", `/api/rooms/${room.id}/members`, body);
    expect(rejected.status, rejected.body).toBe(status);
  }
  expect(JSON.parse((await request("GET", `/api/rooms/${room.id}`)).body).globalMemberIds).toEqual([]);
  const invited = await request("POST", `/api/rooms/${room.id}/members`, { memberId: id });
  expect(invited.status, invited.body).toBe(200);
  expect(JSON.parse(invited.body).globalMemberIds).toEqual([id]);
  expect((await request("POST", `/api/rooms/${room.id}/members`, { memberId: id })).status).toBe(409);
  // Deletion archives the contact and detaches its room memberships. The API
  // requires explicit confirmation, not force or removal from the current room.
  const unconfirmed = await request("DELETE", `/api/members/${id}`);
  expect(unconfirmed.status, unconfirmed.body).toBe(400);
  expect(JSON.parse(unconfirmed.body)).toEqual({ error: "confirm_required", message: "confirm: true required" });
  const retained = await request("GET", `/api/rooms/${room.id}`);
  expect(retained.status, retained.body).toBe(200);
  expect(JSON.parse(retained.body).globalMemberIds).toEqual([id]);
  const deleted = await request("DELETE", `/api/members/${id}`, { confirm: true });
  expect(deleted.status, deleted.body).toBe(200);
  expect(JSON.parse(deleted.body).archived).toMatch(new RegExp(`^backups/fired-${id}-`));
  const detached = await request("GET", `/api/rooms/${room.id}`);
  expect(detached.status, detached.body).toBe(200);
  expect(JSON.parse(detached.body).globalMemberIds).toEqual([]);
  const before = await request("GET", "/api/members");
  expect(before.status, before.body).toBe(200);
  expect(JSON.parse(before.body).members).not.toContainEqual(expect.objectContaining({ memberId: id }));
  expect((await request("POST", `/api/rooms/${room.id}/members`, { memberId: id })).status).toBe(404);
  const stale = await request("POST", "/api/rooms", { name: "Stale selection", memberIds: [id], leaderMemberId: id });
  expect(stale.status).toBe(400);
  expect(JSON.parse(stale.body).error).toBe("member_not_found");
  expect(JSON.parse((await request("GET", "/api/members")).body)).toEqual(JSON.parse(before.body));
});
