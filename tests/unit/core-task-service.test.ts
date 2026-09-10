import {readFileSync,writeFileSync,unlinkSync} from "node:fs";
import {join} from "node:path";
import {it,expect,vi} from "vitest";
import {setupTestWorkspace,createTestServer,closeTestServer,loginAndGetToken,createMockRoom,jsonRequest,getTestBossmodeDir} from "../helpers/test-server.js";
import {createWsClient} from "../helpers/ws-client.js";
import {getDatabase} from "../../src/storage/database.js";
import {readMessages} from "../../src/storage/message-repository.js";
import {mockPromptFn,resetMocks} from "../helpers/mock-runtime.js";
import {handleToolCallback} from "../../src/engine/tools.js";
setupTestWorkspace();
const tables=["tasks","task_comments","task_subscribers","task_references","messages","message_mentions","message_replies","scope_sequences","outbox"];
const snapshot=()=>Object.fromEntries(tables.map(table=>[table,getDatabase().all(`SELECT * FROM ${table}`)]));

it("task changes produce passive timeline and durable UI events without activating assignees or watchers",async()=>{
  const server=await createTestServer();let client:Awaited<ReturnType<typeof createWsClient>>|undefined;
  try{
    resetMocks();const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Task events",["task-peer","task-other"]);
    const [peer,other]=room.globalMemberIds!;client=await createWsClient(server.wsUrl,token);client.send({type:"subscribe:room",roomId:room.id});
    await new Promise<void>(resolve=>{client!.ws.once("pong",()=>resolve());client!.ws.ping();});
    const url=`/api/rooms/${room.id}/tasks`;
    let response=await jsonRequest(server.port,"POST",url,{token,body:{title:"Ticket @task-peer",description:"Useful detail",assignee:peer,subscribers:[other]}});
    expect(response.status,response.body).toBe(200);const task=JSON.parse(response.body);
    response=await jsonRequest(server.port,"PATCH",`${url}/${task.id}`,{token,body:{status:"in-progress",assignee:other}});expect(response.status).toBe(200);
    response=await jsonRequest(server.port,"POST",`${url}/${task.id}/comments`,{token,body:{comment:"Comment @task-peer"}});expect(response.status).toBe(200);const comment=JSON.parse(response.body).comments[0];
    response=await jsonRequest(server.port,"DELETE",`${url}/${task.id}`,{token,body:{}});expect(response.status).toBe(200);
    await client.waitFor(event=>event.type==="task:deleted");
    const events=readMessages(room.id).filter(message=>message.type==="task_event");
    expect(events.map(event=>event.task_event_meta?.action)).toEqual(["created","status_changed","commented","deleted"]);
    expect(events.every(event=>event.mentions.length===0 && !event.mentionMemberIds?.length)).toBe(true);
    expect(events[0].task_event_meta?.snippet).toBe("Useful detail");
    expect(events[1].task_event_meta?.newStatus).toBe("in-progress");
    expect(events[2].task_event_meta).toMatchObject({commentId:comment.id,snippet:"Comment @task-peer"});
    expect(client.events.filter(event=>event.type.startsWith("task:")).map(event=>event.type)).toEqual(["task:created","task:updated","task:updated","task:deleted"]);
    const notifications=getDatabase().all<any>("SELECT * FROM outbox WHERE kind='scope-notification' AND scope_id=?",room.id);
    expect(notifications).toHaveLength(4);expect(notifications.every(row=>row.delivered_at!==null)).toBe(true);
    expect(mockPromptFn).not.toHaveBeenCalled();
  }finally{await client?.close();await closeTestServer(server);}
});

it.each(["create-message","create-notification","update","comment","delete"])("HTTP %s rolls back task, timeline, sequence and outbox together on durable notification failure",async(action)=>{
  const server=await createTestServer();
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,`Rollback ${action}`,[`actor-${action}`]);const id=room.globalMemberIds![0];const url=`/api/rooms/${room.id}/tasks`;
    const created=await jsonRequest(server.port,"POST",url,{token,body:{title:"Original",assignee:id}});expect(created.status).toBe(200);const task=JSON.parse(created.body);
    const before=snapshot();const db=getDatabase();
    db.exec(action==="create-message"?"CREATE TRIGGER task_failure BEFORE INSERT ON messages WHEN NEW.type='task_event' BEGIN SELECT RAISE(ABORT,'task-fault'); END":"CREATE TRIGGER task_failure BEFORE INSERT ON outbox WHEN NEW.kind='scope-notification' BEGIN SELECT RAISE(ABORT,'task-fault'); END");
    const method=action==="update"?"PATCH":action==="delete"?"DELETE":"POST";
    const target=action.startsWith("create")?url:`${url}/${task.id}${action==="comment"?"/comments":""}`;
    const response=await jsonRequest(server.port,method,target,{token,body:{title:"Changed",status:"done",comment:"Changed comment"}});
    expect(response.status,response.body).toBe(500);expect(snapshot()).toEqual(before);db.exec("DROP TRIGGER task_failure");
  }finally{getDatabase().exec("DROP TRIGGER IF EXISTS task_failure");await closeTestServer(server);}
});

it("tool mutations use the same rollback boundary and reject invalid participants atomically",async()=>{
  const server=await createTestServer();
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Tool transaction",["tool-actor","tool-peer"]);const [actor,peer]=room.globalMemberIds!;
    const call=(tool:string,params:any)=>handleToolCallback(tool,room.id,actor,params,{memberId:actor}) as Promise<any>;
    const created=await call("create_task",{title:"Tool task",assignee:peer});expect(created.ok).toBe(true);
    const before=snapshot();getDatabase().exec("CREATE TRIGGER task_failure BEFORE INSERT ON outbox WHEN NEW.kind='scope-notification' BEGIN SELECT RAISE(ABORT,'task-fault'); END");
    for(const [tool,params] of [["create_task",{title:"Rejected"}],["update_task",{taskId:created.taskId,status:"done"}],["comment_task",{taskId:created.taskId,comment:"Rejected"}]] as const){expect(await call(tool,params)).toMatchObject({ok:false});expect(snapshot()).toEqual(before);}
    getDatabase().exec("DROP TRIGGER task_failure");
    expect(await call("update_task",{taskId:created.taskId,assignee:actor,subscribers:["missing"]})).toMatchObject({ok:false});expect(snapshot()).toEqual(before);
  }finally{getDatabase().exec("DROP TRIGGER IF EXISTS task_failure");await closeTestServer(server);}
});

it("roster and task transactions read avatar metadata without opening template bodies",async()=>{
  const server=await createTestServer();let file:string|undefined;let body:Buffer|undefined;
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Metadata only",["metadata-only"]);const id=room.globalMemberIds![0];
    const {TemplateRepository}=await import("../../src/storage/repositories/templates.js");
    const template=new TemplateRepository(getDatabase()).get("general")!;
    file=join(getTestBossmodeDir(),template.personaPath);body=readFileSync(file);unlinkSync(file);
    const rooms=await import("../../src/workspace/room-store.js");
    expect(getDatabase().transaction(()=>rooms.getRoom(room.id)?.members)).toContain("metadata-only");
    const response=await jsonRequest(server.port,"POST",`/api/rooms/${room.id}/tasks`,{token,body:{title:"Does not need a template body",assignee:id}});
    expect(response.status,response.body).toBe(200);
    const {loadAgentDefinition,saveAgentDefinition}=await import("../../src/workforce/agent-store.js");
    expect(()=>getDatabase().transaction(()=>loadAgentDefinition("general"))).toThrow("no enclosing database transaction");
    expect(()=>getDatabase().transaction(()=>saveAgentDefinition("general","---\nname: General\n---\nbody"))).toThrow("no enclosing database transaction");
    expect(()=>loadAgentDefinition("general")).toThrow(); // explicit body reads still fail honestly
  }finally{if(file&&body)writeFileSync(file,body);await closeTestServer(server);}
});
