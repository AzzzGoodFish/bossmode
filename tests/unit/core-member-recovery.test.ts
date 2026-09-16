import { it, expect, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, loginAndGetToken, jsonRequest } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn, MockRuntime } from "../helpers/mock-runtime.js";
import { shutdownAll, initAgentManager, resumePendingRuntimeInputs, getActiveInstanceCount } from "../../src/engine/agent-manager.js";
import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { getDatabase } from "../../src/data/database.js";
setupTestWorkspace();

const barrier = () => { let release!: () => void; const promise = new Promise<void>((r) => (release = r)); return { promise, release }; };
const pendingCount = (scopeId: string) => getDatabase().get<{ n: number }>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='pending'", scopeId)?.n ?? -1;

// ① B7: pending work in every chat survives a restart and drains through one
// rebuilt member instance — recovery is member-level now, not per scope.
it("restart resumes pending work from every chat through one rebuilt instance", async () => {
  const server = await createTestServer(); resetMocks();
  const token = await loginAndGetToken(server.port);
  const gate = barrier();
  try {
    const room = await createMockRoom(server.port, token, "Recovery", ["recover-owner"]);
    const id = room.globalMemberIds![0];
    const post = (text: string) => jsonRequest(server.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: `@recover-owner ${text}` } });

    // Hold the first turn; the next inputs pile up as pending work in two chats.
    mockPromptFn.mockImplementation(async () => { await gate.promise; });
    expect((await post("room first")).status).toBe(200);
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(1));
    expect((await post("room second")).status).toBe(200);
    await vi.waitFor(() => expect(pendingCount(room.id)).toBe(1));
    expect((await jsonRequest(server.port, "POST", `/api/dm/${id}/messages`, { token, body: { content: "dm resume" } })).status).toBe(200);
    await vi.waitFor(() => expect(pendingCount(`dm:${id}`)).toBe(1));

    // Restart: teardown, then a fresh manager resumes what is still pending.
    const stop = shutdownAll(); gate.release(); await stop;
    mockPromptFn.mockImplementation(async () => { /* prompts run free after restart */ });
    const registry = new RuntimeRegistry(); registry.register(new MockRuntime("pi-cli"));
    initAgentManager(registry);
    resumePendingRuntimeInputs();

    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(3), { timeout: 15000 });
    const prompts = mockPromptFn.mock.calls.map((call) => String(call[0]));
    expect(prompts.some((prompt) => prompt.includes("room second"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("dm resume"))).toBe(true);
    expect(getActiveInstanceCount()).toBe(1);
    await vi.waitFor(() => expect(pendingCount(room.id)).toBe(0));
    expect(pendingCount(`dm:${id}`)).toBe(0);
  } finally { gate.release(); await shutdownAll(); await closeTestServer(server); }
});
