import { it, expect, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, loginAndGetToken, jsonRequest } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn, MockRuntime, MockAgentHandle } from "../helpers/mock-runtime.js";
import { getDatabase } from "../../src/storage/database.js";
import { ReplyObligationRepository } from "../../src/storage/repositories/reply-obligation-repository.js";
import { resolveRoomMemberRef } from "../../src/workspace/room-store.js";
import { handleToolCallback } from "../../src/engine/tools.js";
import { getAgentInstanceForScope } from "../../src/engine/agent-manager.js";
setupTestWorkspace();
const barrier = () => { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; };
async function fixture() {
  const server = await createTestServer(); resetMocks();
  const token = await loginAndGetToken(server.port);
  const room = await createMockRoom(server.port, token, "Revocation", ["revoked", "controller"]);
  const [id, controller] = room.globalMemberIds!;
  const scope = room.id;
  const path = `/api/rooms/${room.id}/messages`;
  return { server, token, room, id, controller, scope,
    post: (text: string) => jsonRequest(server.port, "POST", path, { token, body: { content: `@revoked ${text}` } }),
    remove: async (via: "api" | "tool" = "api") => {
      if (via === "api") expect((await jsonRequest(server.port, "DELETE", `/api/rooms/${room.id}/members/${id}`, { token })).status).toBe(200);
      else expect(await handleToolCallback("edit_room", room.id, "controller", { roomId: room.id, removeMemberIds: [id] }, { memberId: controller })).toMatchObject({ ok: true });
      expect(resolveRoomMemberRef(room.id, id)).toBeNull();
    },
  };
}
const pending = (scope: string) => getDatabase().get<{ id: number; dispatch_token: string | null }>("SELECT id,dispatch_token FROM queued_inputs WHERE scope_id=? AND status='pending' ORDER BY id DESC LIMIT 1", scope);
const assertCancelled = (inputId: number) => {
  // Never dispatched: no execution outcome is invented. Cancellation is a reply disposition.
  expect(getDatabase().get("SELECT status,outcome,dispatch_token FROM queued_inputs WHERE id=?", inputId)).toMatchObject({ status: "interrupted", outcome: null, dispatch_token: null });
  expect(getDatabase().get(`SELECT d.disposition FROM reply_obligation_dispositions d JOIN queued_inputs q
    ON q.scope_id=d.scope_id AND q.message_id=d.message_id AND q.target_actor_key=d.actor_key WHERE q.id=?`, inputId)).toMatchObject({ disposition: "cancelled" });
};
const debts = (scope: string, id: string) => new ReplyObligationRepository(getDatabase()).listPending(scope, id);

it.each(["api", "tool"] as const)("does not dispatch pending room input after membership removal through %s", async (via) => {
  const f = await fixture(), gate = barrier();
  try {
    mockPromptFn.mockImplementationOnce(() => gate.promise);
    expect((await f.post("first")).status).toBe(200);
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(1));
    expect((await f.post("queued after first")).status).toBe(200);
    await vi.waitFor(() => expect(pending(f.scope)).toBeTruthy());
    const input = pending(f.scope)!; expect(input.dispatch_token).toBeNull();
    await f.remove(via); gate.release();
    await vi.waitFor(() => assertCancelled(input.id));
    expect(mockPromptFn).toHaveBeenCalledTimes(1);
    expect(debts(f.scope, f.id)).toEqual([]);
    // Room revocation is not global member suspension: the owned DM still works.
    expect((await jsonRequest(f.server.port, "POST", `/api/dm/${f.id}/messages`, { token: f.token, body: { content: "still permitted in my DM" } })).status).toBe(200);
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(2));
  } finally { gate.release(); await closeTestServer(f.server); }
});

it("rejects a builder completing after membership removal and cancels its pending input", async () => {
  const f = await fixture(), gate = barrier(), original = MockRuntime.prototype.createAgent;
  const spy = vi.spyOn(MockRuntime.prototype, "createAgent").mockImplementation(async function(options) { await gate.promise; return original.call(this, options); });
  try {
    await f.post("blocked creation"); await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    const input = pending(f.scope)!; expect(input).toBeTruthy();
    await f.remove(); gate.release();
    await vi.waitFor(() => assertCancelled(input.id));
    expect(mockPromptFn).not.toHaveBeenCalled();
    expect(getAgentInstanceForScope(f.scope, f.id)).toBeNull();
    expect(debts(f.scope, f.id)).toEqual([]);
  } finally { gate.release(); spy.mockRestore(); await closeTestServer(f.server); }
});

it("rechecks membership inside the actual dispatch hook after a delayed runtime preflight", async () => {
  const f = await fixture(), gate = barrier(), original = MockAgentHandle.prototype.prompt;
  const spy = vi.spyOn(MockAgentHandle.prototype, "prompt").mockImplementation(async function(message, options) { await gate.promise; return original.call(this, message, options); });
  try {
    await f.post("blocked before dispatch"); await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    const input = pending(f.scope)!; expect(input).toBeTruthy();
    await f.remove(); gate.release();
    await vi.waitFor(() => assertCancelled(input.id));
    expect(mockPromptFn).not.toHaveBeenCalled();
    expect(debts(f.scope, f.id)).toEqual([]);
  } finally { gate.release(); spy.mockRestore(); await closeTestServer(f.server); }
});
