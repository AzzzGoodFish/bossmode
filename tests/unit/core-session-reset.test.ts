import { it,expect } from "vitest";
import { mkdirSync,writeFileSync,readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace,createTestServer,closeTestServer,loginAndGetToken,createMockRoom } from "../helpers/test-server.js";
import { getDatabase } from "../../src/data/database.js";
import { resetAgentSession } from "../../src/engine/agent-manager.js";
import * as sessions from "../../src/workspace/session-store.js";
import * as rooms from "../../src/workspace/room-store.js";
import * as runtime from "../../src/workspace/runtime-state.js";
import { updateMemberIdentity } from "../../src/workspace/member-registry.js";
setupTestWorkspace();

it.each(["checkpoint","cursor","event"])("reset is atomic through %s failure and never treats a display name as another session owner",async(fault)=>{
  const server=await createTestServer();
  try{
    const token=await loginAndGetToken(server.port);
    const room=await createMockRoom(server.port,token,`Reset ${fault}`,[`reset-${fault}`,`other-${fault}`]);
    const [id,other]=room.globalMemberIds!;
    updateMemberIdentity(id,{name:other}); // legal ID-shaped name, not ownership
    const files:string[]=[];
    for(const member of [id,other]){
      const directory=sessions.mainSessionDirectory(member);mkdirSync(directory,{recursive:true});
      const file=join(directory,"retained.jsonl");writeFileSync(file,`SDK history ${member}\n`);files.push(file);
      sessions.saveCurrentSession(member,{runtime:"pi-cli",sessionId:member,sessionFile:file});
      runtime.setContractFingerprint(member,"retained",1);
      runtime.markStaleMounts(member,["skills"]);
      rooms.setCursor(room.id,member,`cursor-${member}`);
    }
    const db=getDatabase();
    const snapshot=()=>Object.fromEntries(["current_sessions","runtime_checkpoints","runtime_stale_fields","read_cursors","agent_events","outbox"].map(table=>[table,db.all(`SELECT * FROM ${table}`)]));
    const before=snapshot();
    const target=fault==="checkpoint"?`BEFORE DELETE ON runtime_checkpoints WHEN OLD.member_id='${id}'`:fault==="cursor"?`BEFORE INSERT ON read_cursors WHEN NEW.actor_key='${id}'`:`BEFORE INSERT ON agent_events WHEN NEW.member_id='${id}'`;
    db.exec(`CREATE TRIGGER reset_fault ${target} BEGIN SELECT RAISE(ABORT,'reset-fault'); END`);
    expect(()=>resetAgentSession(room.id,id)).toThrow("reset-fault");expect(snapshot()).toEqual(before);
    db.exec("DROP TRIGGER reset_fault");
    expect(resetAgentSession(room.id,id)).toMatchObject({ok:true});
    expect(sessions.getCurrentSession(id)).toBeUndefined();
    expect(runtime.getRuntimeStateEntry(id)).toEqual({});
    expect(rooms.getCursors(room.id)[id]).toBeNull();
    expect(sessions.getCurrentSession(other)?.sessionId).toBe(other);
    expect(runtime.getRuntimeStateEntry(other)).toMatchObject({contractFingerprint:"retained"});
    expect(rooms.getCursors(room.id)[other]).toBe(`cursor-${other}`);
    expect(files.map(file=>readFileSync(file,"utf8"))).toEqual([`SDK history ${id}\n`,`SDK history ${other}\n`]);
    expect(db.get("SELECT member_id FROM agent_events WHERE scope_id=? AND owner_key=?",room.id,id)).toMatchObject({member_id:id});
  }finally{await closeTestServer(server);}
});
