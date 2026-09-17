import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace, createTestServer, closeTestServer, loginAndGetToken, jsonRequest, getTestBossmodeDir } from "../helpers/test-server.js";
import { createMemberWithPersona } from "../../src/app/member-actions.js";
import { getDatabase } from "../../src/data/database.js";
setupTestWorkspace();
const countRooms = () => getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM rooms")!.n;

it("creates a deduplicated stable-ID roster and leader without cloning or renaming contacts", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const a = createMemberWithPersona({name: "架构 同学"}, "\uFEFF---\r\nLiteral `persona`\r\n"), b = createMemberWithPersona({name: "mem_literal-name"}, "  Second persona  ");
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("localStorage", {getItem: () => null, setItem() {}, removeItem() {}});
    vi.stubGlobal("fetch", (path: string, options: RequestInit) => actualFetch(`http://127.0.0.1:${server.port}${path}`, options));
    try {
      const client = await import("../../web/src/api/client");
      client.setToken(token);
      const contacts = await client.getMembers();
      expect(contacts.map(contact => [contact.id, contact.name])).toEqual(expect.arrayContaining([[a.id,a.name],[b.id,b.name]]));
    } finally { vi.unstubAllGlobals(); }
    const before = getDatabase().all("SELECT * FROM members ORDER BY id");
    const response = await jsonRequest(server.port, "POST", "/api/rooms", {token, body:{name:"Contacts room",memberIds:[a.id,b.id,a.id],leaderMemberId:b.id}});
    expect(response.status).toBe(200);
    const room = JSON.parse(response.body);
    expect(room.globalMemberIds).toEqual([a.id,b.id]); expect(room.members).toEqual([a.name,b.name]);
    expect(room.promptLeaderMemberId).toBe(b.id);
    expect(getDatabase().all("SELECT * FROM members ORDER BY id")).toEqual(before);
    expect(readFileSync(join(getTestBossmodeDir(),"members",a.id,"persona.md"),"utf8")).toBe("\uFEFF---\r\nLiteral `persona`\r\n");
    expect(JSON.parse((await jsonRequest(server.port,"GET",`/api/rooms/${room.id}`,{token})).body)).toMatchObject({globalMemberIds:[a.id,b.id],promptLeaderMemberId:b.id});
  } finally { await closeTestServer(server); }
});

it("rejects names, coercion, template drafts and nonmember leaders without partial creation", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const member = createMemberWithPersona({name:"mem_looks-like-an-id"}, "");
    const before = countRooms();
    for(const body of [
      {members:[{agent:"general",name:"clone"}],promptLeaderMemberName:"clone"},
      {memberIds:[member.id],members:[]}, {memberIds:[member.name]}, {memberIds:[member.id,"mem_missing"]},
      {memberIds:[42]}, {memberIds:[member.id],leaderMemberId:member.name}, {memberIds:[member.id],leaderMemberId:42},
    ]) {
      expect((await jsonRequest(server.port,"POST","/api/rooms",{token,body:{name:"Rejected",...body}})).status).toBe(400);
      expect(countRooms()).toBe(before);
    }
    for(const [method,path] of [["POST","/api/members"],["PATCH",`/api/members/${member.id}`]]) {
      expect((await jsonRequest(server.port,method,path,{token,body:{agentTemplate:"general"}})).status).toBe(400);
    }
  } finally { await closeTestServer(server); }
});

it("invites an existing contact only by ID and does not expose retired template routes", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const member = createMemberWithPersona({name:"Invite `contact`"}, "");
    const created = await jsonRequest(server.port,"POST","/api/rooms",{token,body:{name:"Empty room",memberIds:[]}});
    expect(created.status).toBe(200); const room = JSON.parse(created.body);
    for(const body of [{agent:"general",name:"clone"},{memberId:member.name},{memberId:member.id,name:"rename"}]) {
      const result = await jsonRequest(server.port,"POST",`/api/rooms/${room.id}/members`,{token,body});
      expect([400,404]).toContain(result.status);
    }
    expect((await jsonRequest(server.port,"POST",`/api/rooms/${room.id}/members`,{token,body:{memberId:member.id}})).status).toBe(200);
    expect((await jsonRequest(server.port,"POST",`/api/rooms/${room.id}/members`,{token,body:{memberId:member.id}})).status).toBe(409);
    expect(JSON.parse((await jsonRequest(server.port,"GET",`/api/rooms/${room.id}`,{token})).body)).toMatchObject({globalMemberIds:[member.id],members:[member.name]});
    for(const path of ["/api/agents","/api/agents/templates","/api/templates"])
      expect((await jsonRequest(server.port,"GET",path,{token})).status).toBe(404);
  } finally { await closeTestServer(server); }
});
