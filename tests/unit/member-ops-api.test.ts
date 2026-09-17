import { mainSessionDirectory } from "../../src/files/layout.js";
import { it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, loginAndGetToken, jsonRequest } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn } from "../helpers/mock-runtime.js";
import { getMemberInstances } from "../../src/agent/orchestrator/agent-manager.js";
import * as sessions from "../../src/member/sessions.js";
setupTestWorkspace();

const barrier = () => { let release!: () => void; const promise = new Promise<void>((r) => (release = r)); return { promise, release }; };
const parse = (res: { body: string }) => JSON.parse(res.body);

// ① B5: stop / compact / reset / restart target the member directly — the
// request names no room, and the single member runtime serves every chat.
it("member-level operations target the member directly across chats", async () => {
  const server = await createTestServer(); resetMocks();
  try {
    const token = await loginAndGetToken(server.port);
    const room = await createMockRoom(server.port, token, "Member ops", ["ops"]);
    const id = room.globalMemberIds![0];
    const post = (path: string) => jsonRequest(server.port, "POST", path, { token, body: {} });

    // Nothing running: stop reports honestly instead of erroring.
    expect(parse(await post(`/api/members/${id}/stop`))).toMatchObject({ ok: false, action: "not_found" });

    // A live turn is stopped by member id — the request names no room.
    const gate = barrier();
    mockPromptFn.mockImplementationOnce(() => gate.promise);
    expect((await jsonRequest(server.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@ops hello" } })).status).toBe(200);
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(1));
    const stop = await post(`/api/members/${id}/stop`);
    expect(stop.status).toBe(200);
    expect(parse(stop)).toMatchObject({ ok: true, action: "aborted" });
    gate.release();
    await vi.waitFor(() => expect(getMemberInstances(id)[0]?.status).toBe("idle"), { timeout: 10000 });

    // Compaction follows the member the same way (its live chat is the one it serves).
    const compact = await post(`/api/members/${id}/compact`);
    expect(compact.status).toBe(200);
    expect(parse(compact)).toMatchObject({ ok: true, action: "compacted" });

    // Reset clears the member's stored session from any interface.
    const directory = mainSessionDirectory(id); mkdirSync(directory, { recursive: true });
    const file = join(directory, "retained.jsonl"); writeFileSync(file, "SDK history\n");
    sessions.saveCurrentSession(id, { runtime: "pi-cli", sessionId: id, sessionFile: file });
    const reset = await post(`/api/members/${id}/reset`);
    expect(reset.status).toBe(200);
    expect(parse(reset)).toMatchObject({ ok: true });
    expect(sessions.getCurrentSession(id)).toBeUndefined();
    expect(getMemberInstances(id)).toEqual([]);

    // Restart also leaves the member with no runtime to rebuild on demand.
    expect(parse(await post(`/api/members/${id}/restart`))).toMatchObject({ ok: true });
    expect(getMemberInstances(id)).toEqual([]);

    // Unknown members are rejected before the engine is touched.
    expect((await post("/api/members/mem_missing/stop")).status).toBe(404);
  } finally { await closeTestServer(server); }
});
