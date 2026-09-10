import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeTestServer, createTestServer, createMockRoom, getTestBossmodeDir, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";
import { appendAgentEvent } from "../../src/storage/event-repository.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { getDatabase } from "../../src/storage/database.js";
import { stampGlobalMemberIds } from "../../src/workspace/room-store.js";
setupTestWorkspace();

it("reports SQL room/DM/topic usage, retains stable identity after rename/removal, and fails rather than returning false zeros", async () => {
  const server = await createTestServer();
  try {
    const login = await jsonRequest(server.port,"POST","/api/auth/login",{body:{username:"testuser",password:"testpass"}});
    const token = JSON.parse(login.body).token;
    const room = await createMockRoom(server.port,token,"Usage fixture",["usage-person"]);
    const id = room.globalMemberIds![0];
    const topic = "usage-topic";
    new ConversationsRepository().upsertTopic({id:topic,roomId:room.id,title:"Usage topic",anchorMessageId:"anchor",createdBy:"user",createdAt:0,status:"active",seedMode:"fresh",participants:[]});
    for (const [scope,model,amount] of [[room.id,"room-model",10],[`dm:${id}`,"dm-model",20],[`topic:${topic}`,"topic-model",30]] as const) {
      const event={type:"message_end",ts:Date.UTC(2026,8,10),model,usage:{inputTokens:amount,outputTokens:1,cost:0.1}};
      appendAgentEvent(scope,{ownerKey:id,memberId:id},event,`usage-${model}`);
      appendAgentEvent(scope,{ownerKey:id,memberId:id},event,`usage-${model}`);
    }
    const directory=join(getTestBossmodeDir(),"rooms",room.id,"agent-events");mkdirSync(directory,{recursive:true});
    writeFileSync(join(directory,`${id}.jsonl`),JSON.stringify({type:"message_end",usage:{inputTokens:99999}}));
    const get=async(path:string)=>{const result=await jsonRequest(server.port,"GET",path,{token});expect(result.status,result.body).toBe(200);return JSON.parse(result.body);};
    expect((await get(`/api/rooms/${room.id}/usage`)).kpis.inputTokens).toBe(10);
    expect((await get("/api/usage?model=dm-model")).kpis.inputTokens).toBe(20);
    const original=await get("/api/usage?from=2026-09-10&to=2026-09-10");
    expect(original.kpis).toMatchObject({inputTokens:60,outputTokens:3,turns:3});
    expect(original.byRoom).toHaveLength(3);expect(original).not.toHaveProperty("backfillStatus");
    expect((await jsonRequest(server.port,"PATCH",`/api/members/${id}`,{token,body:{name:"usage-renamed"}})).status).toBe(200);
    stampGlobalMemberIds(room.id,[]);
    const renamed=await get("/api/usage");
    expect(renamed.kpis.inputTokens).toBe(60);expect(renamed.breakdown.every((r:any)=>r.memberId===id && r.memberName==="usage-renamed")).toBe(true);
    expect((await get("/api/usage?agent=general")).kpis.inputTokens).toBe(60);
    const db=getDatabase();db.exec("ALTER TABLE token_usage_daily RENAME TO unavailable_usage");
    try {
      for(const path of ["/api/usage",`/api/rooms/${room.id}/usage`])expect((await jsonRequest(server.port,"GET",path,{token})).status).toBe(500);
    } finally {db.exec("ALTER TABLE unavailable_usage RENAME TO token_usage_daily");}
    expect((await get("/api/usage")).kpis.inputTokens).toBe(60);
    expect((await jsonRequest(server.port,"GET","/api/rooms/missing/usage",{token})).status).toBe(404);
  } finally {await closeTestServer(server);}
});
