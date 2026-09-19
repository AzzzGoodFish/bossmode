import { mainSessionDirectory } from "../../src/files/layout.js";
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, loginAndGetToken, jsonRequest } from "../helpers/test-server.js";
import * as sessions from "../../src/member/sessions.js";
setupTestWorkspace();

const parse = (res: { body: string }) => JSON.parse(res.body);

// Stop / reset / restart target the member directly — the request names no
// room, and the single member runtime serves every chat. Compaction's handle
// semantics are covered by the focused agent-control suite.
it("member-level operations target the member directly across chats", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const room = await createMockRoom(server.port, token, "Member ops", ["ops"]);
    const id = room.memberIds[0];
    const post = (path: string) => jsonRequest(server.port, "POST", path, { token, body: {} });

    // Nothing running: stop reports honestly instead of erroring.
    expect(parse(await post(`/api/members/${id}/stop`))).toMatchObject({ ok: false, action: "not_found" });

    // Reset clears the member's stored session from any interface.
    const directory = mainSessionDirectory(id); mkdirSync(directory, { recursive: true });
    const file = join(directory, "retained.jsonl"); writeFileSync(file, "SDK history\n");
    sessions.saveCurrentSession(id, { runtime: "pi-cli", sessionId: id, sessionFile: file });
    const reset = await post(`/api/members/${id}/reset`);
    expect(reset.status).toBe(200);
    expect(parse(reset)).toMatchObject({ ok: true });
    expect(sessions.getCurrentSession(id)).toBeUndefined();

    // Restart also leaves the member with no runtime to rebuild on demand.
    expect(parse(await post(`/api/members/${id}/restart`))).toMatchObject({ ok: true });

    // Unknown members are rejected before the engine is touched.
    expect((await post("/api/members/mem_missing/stop")).status).toBe(404);
  } finally { await closeTestServer(server); }
});
