import { it, expect, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, loginAndGetToken, jsonRequest } from "../helpers/test-server.js";
import { createMemberWithPersona } from "../../src/workspace/member-registry.js";
import { updateProfileForMember } from "../../src/engine/member-profile-update.js";
import { createRoom } from "../../src/workspace/room-store.js";
import { appendMessage, readMessages } from "../../src/data/repositories/message-repository.js";
import { getDatabase } from "../../src/data/database.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
setupTestWorkspace();

it("serves only canonical ID/name pairs, including retained archives, without reading their config/bodies", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const live = createMemberWithPersona({name: "identity-live"}, "Literal persona");
    const retired = createMemberWithPersona({name: "identity-retired"}, "Retained persona");
    const repo = new MembersRepository(getDatabase());
    updateProfileForMember(retired.id, {name: "archive final name"});
    repo.archive(retired.id, "backups/identity-retired", 5);
    const fresh = createMemberWithPersona({name: "identity-retired"}, "A different identity");
    expect((await jsonRequest(server.port,"GET","/api/members/identities")).status).toBe(401);
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("localStorage", {getItem: () => null, setItem() {}, removeItem() {}});
    vi.stubGlobal("fetch", (path: string, options: RequestInit) => actualFetch(`http://127.0.0.1:${server.port}${path}`, options));
    try {
      const client = await import("../../web/src/api/client"); client.setToken(token);
      const identities = await client.getMemberIdentities();
      expect(identities).toEqual(expect.arrayContaining([
        {id:live.id,name:live.name}, {id:retired.id,name:"archive final name"}, {id:fresh.id,name:fresh.name},
      ]));
      expect(identities.every(identity => Object.keys(identity).sort().join() === "id,name")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
    expect(repo.get(retired.id)).toBeNull();
    expect(repo.getRetained(retired.id)?.name).toBe("archive final name");
  } finally { await closeTestServer(server); }
});

it("searches a selected author by ID across rename/name reuse without rewriting message facts", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const original = createMemberWithPersona({name:"historical-author"}, "");
    const room = createRoom("History search", undefined, [original.id]);
    const first = appendMessage(room.id, {sender:original.name,senderMemberId:original.id,content:"before rename",mentions:[]});
    const unknown = appendMessage(room.id, {sender:original.name,content:"unknown historical actor",mentions:[]});
    updateProfileForMember(original.id,{name:"current author"});
    const next = appendMessage(room.id, {sender:"current author",senderMemberId:original.id,content:"after rename",mentions:[]});
    const reuse = createMemberWithPersona({name:"historical-author"}, "");
    const other = appendMessage(room.id, {sender:reuse.name,senderMemberId:reuse.id,content:"name reused",mentions:[]});
    const before = readMessages(room.id);
    const search = async (query: string) => JSON.parse((await jsonRequest(server.port,"GET",`/api/rooms/${room.id}/messages/search?${query}`,{token})).body);
    const selected = await search(`fromMemberId=${original.id}`);
    expect(selected.total).toBe(2);
    expect(selected.messages.map((m: any)=>m.id).sort()).toEqual([first.id,next.id].sort());
    expect((await search(`fromMemberId=${reuse.id}`)).messages.map((m: any)=>m.id)).toEqual([other.id]);
    expect((await search("fromMemberId=mem_missing")).total).toBe(0);
    expect((await search("from=historical-author")).messages.map((m:any)=>m.id).sort()).toEqual([first.id,unknown.id,other.id].sort());
    expect((await search(`fromMemberId=${original.id}&from=historical-author`)).messages.map((m:any)=>m.id)).toEqual([first.id]);
    const chats = JSON.parse((await jsonRequest(server.port,"GET","/api/chats",{token})).body).chats;
    expect(chats.find((c:any)=>c.scopeId===`room:${room.id}`).lastMessage).toMatchObject({senderMemberId:reuse.id,sender:"historical-author"});
    expect(readMessages(room.id)).toEqual(before);
  } finally { await closeTestServer(server); }
});
