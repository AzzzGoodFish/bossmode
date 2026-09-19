/**
 * Item-5 preview (pm/architect 2026-09-02): GET /api/members/:id/system-prompt
 * must return the byte-identical compiled prompt the activation path injects.
 */
import { describe, expect, it } from "vitest";
import {closeTestServer,createTestServer,jsonRequest,loginAndGetToken,setupTestWorkspace} from "../helpers/test-server.js";

setupTestWorkspace();

describe("member system-prompt preview", () => {
  it("room scope: preview is byte-identical to activation compile", async () => {
    const ts = await createTestServer();
    const token = await loginAndGetToken(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "prompt-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;

    const room = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,body:{name:"sysprompt-room",memberIds:[memberId]},
    });
    const roomId = JSON.parse(room.body).id as string;
    const scopeId = `room:${roomId}`;

    const res = await jsonRequest(ts.port, "GET", `/api/members/${memberId}/system-prompt?scope=${encodeURIComponent(scopeId)}`, { token });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scopeId).toBe(scopeId);
    expect(typeof body.contractFingerprint).toBe("string");
    expect(body.charCount).toBe(body.text.length);

    // Same-process compile with the exact member-level arguments (② batch 2).
    const { previewMemberPrompt } = await import("../../src/app/member-actions.js");
    const { getMember } = await import("../../src/member/identity.js");
    const m = getMember(memberId)!;
    const compiled = previewMemberPrompt(m.id);
    expect(body.text).toBe(compiled.fullPrompt);
    expect(body.contractFingerprint).toBe(compiled.contractFingerprint);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await closeTestServer(ts);
  });

  it("supports an unscoped preview and rejects an unknown member",async()=>{
    const ts = await createTestServer();
    const token = await loginAndGetToken(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "scope-bot" },
    });
    const memberId = JSON.parse(created.body).member.memberId as string;
    const unscoped=await jsonRequest(ts.port,"GET",`/api/members/${memberId}/system-prompt`,{token});
    expect(unscoped.status).toBe(200);expect(JSON.parse(unscoped.body).scopeId).toBeNull();
    expect((await jsonRequest(ts.port, "GET", "/api/members/mem_does_not_exist/system-prompt?scope=dm:mem_does_not_exist", { token })).status).toBe(404);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await closeTestServer(ts);
  });
});
