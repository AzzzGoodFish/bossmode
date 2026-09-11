/**
 * Item-5 preview (pm/architect 2026-09-02): GET /api/members/:id/system-prompt
 * must return the byte-identical compiled prompt the activation path injects.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { closeTestServer, createTestServer, getTestBossmodeDir, jsonRequest, loginAndGetToken, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

describe("member system-prompt preview", () => {
  it("room scope: preview is byte-identical to activation compile", async () => {
    const ts = await createTestServer();
    const token = await loginAndGetToken(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "prompt-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;

    const cwd = getTestBossmodeDir();
    const room = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token, body: { name: "sysprompt-room", cwd, memberIds: [memberId] },
    });
    const roomId = JSON.parse(room.body).id as string;
    const scopeId = `room:${roomId}`;

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt?scope=${encodeURIComponent(scopeId)}`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scopeId).toBe(scopeId);
    expect(typeof body.contractFingerprint).toBe("string");
    expect(body.charCount).toBe(body.text.length);

    // Same-process compile with the exact room-activation arguments.
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const { getRoom } = await import("../../src/workspace/room-store.js");
    const { getMember } = await import("../../src/workspace/member-registry.js");
    const m = getMember(memberId)!;
    const compiled = compileMemberPromptForScope({
      scopeId,
      memberId: m.id,
      memberName: m.name,
      room: getRoom(roomId),
      docsRoot: join(getTestBossmodeDir(), "memory", "projects"),
    });
    // Final text = compiled segments + pi's trailing cwd line (byte-exact;
    // contract test in system-prompt-final.test.ts locks the full assembly).
    expect(body.text.startsWith(compiled.fullPrompt)).toBe(true);
    // Batch 7 P1: session cwd = active workspace root (original → member dir).
    const { activeWorkspaceRoot } = await import("../../src/workspace/workspace-registry.js");
    const sessionCwd = activeWorkspaceRoot(memberId);
    expect(body.text.endsWith(`\nCurrent working directory: ${sessionCwd.replace(/\\/g, "/")}`)).toBe(true);
    expect(body.contractFingerprint).toBe(compiled.contractFingerprint);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await closeTestServer(ts);
  });

  it("rejects unknown member / bad scope / non-member scope", async () => {
    const ts = await createTestServer();
    const token = await loginAndGetToken(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "scope-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    const outsider = await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "outsider-bot" },
    });
    const outsiderId = JSON.parse(outsider.body).member.memberId as string;

    const room = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token, body: { name: "sysprompt-room2", cwd: getTestBossmodeDir(), memberIds: [memberId] },
    });
    const roomId = JSON.parse(room.body).id as string;

    expect((await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt`, { token })).status).toBe(400);
    expect((await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt?scope=nonsense`, { token })).status).toBe(400);
    expect((await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt?scope=topic:topic_missing`, { token })).status).toBe(400);
    expect((await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt?scope=dm:${outsiderId}`, { token })).status).toBe(404);
    expect((await jsonRequest(ts.port, "GET", `/api/members/${outsiderId}/system-prompt?scope=${encodeURIComponent(`room:${roomId}`)}`, { token })).status).toBe(404);
    expect((await jsonRequest(ts.port, "GET", "/api/members/mem_does_not_exist/system-prompt?scope=dm:mem_does_not_exist", { token })).status).toBe(404);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await jsonRequest(ts.port, "DELETE", `/api/members/${outsiderId}`, { token, body: { confirm: true } });
    await closeTestServer(ts);
  });
});
