import {postMessage} from "../../src/chat/message-bus.js";
import {patchMessage,readMessages} from "../../src/data/repositories/message-repository.js";
import {ReplyObligationRepository} from "../../src/data/repositories/reply-obligation-repository.js";
import {it,expect,vi} from "vitest";
import {setupTestWorkspace,createTestServer,closeTestServer,createMockRoom,loginAndGetToken,jsonRequest} from "../helpers/test-server.js";
import {resetMocks,mockPromptFn,mockAbortFn,emitMockEvent} from "../helpers/mock-runtime.js";
import {DeliveryRepository} from "../../src/data/repositories/delivery-repository.js";
import {getDatabase} from "../../src/data/database.js";
setupTestWorkspace();

it("room @all reaches every member (a busy one is interrupted, not skipped); `!name` stays plain text",async()=>{
  const server=await createTestServer();let release:undefined|(()=>void);
  try{
    resetMocks();const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Broadcast admission",["busy-broadcast","idle-broadcast"]);
    const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
    mockPromptFn.mockImplementation(async()=>{if(++calls===1)await gate;});
    const post=(content:string)=>jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content}});
    expect((await post("@busy-broadcast initial work")).status).toBe(200);
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));mockAbortFn.mockClear();
    const response=await post("@all FYI !busy-broadcast");expect(response.status,response.body).toBe(200);
    // ① B3: @everyone is a real mention — the busy member's turn is interrupted
    // and the message is re-delivered, never skipped.
    await vi.waitFor(()=>expect(mockAbortFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));
    const body=JSON.parse(response.body);const message=body.message??body;
    const capture=new DeliveryRepository(getDatabase()).getCapture(room.id,message.id)!;
    expect(capture.snapshot.targets.ordinary.map(actor=>actor.actorKey)).toEqual(room.globalMemberIds);
  }finally{release?.();await closeTestServer(server);}
});

it("HTTP DM posting captures one recipient and invokes the runtime only once",async()=>{
  const server=await createTestServer();
  try{
    resetMocks();const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"DM capture",["dm-capture-owner"]);const id=room.globalMemberIds![0];
    const response=await jsonRequest(server.port,"POST",`/api/dm/${id}/messages`,{token,body:{content:"Direct request"}});expect(response.status,response.body).toBe(200);
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));await new Promise<void>(resolve=>setImmediate(resolve));expect(mockPromptFn).toHaveBeenCalledTimes(1);
    const message=JSON.parse(response.body).message;
    expect(new DeliveryRepository(getDatabase()).getCapture(`dm:${id}`,message.id)?.snapshot).toMatchObject({origin:"user",targets:{ordinary:[],dm:[{actorKey:id,memberId:id}]}});
  }finally{await closeTestServer(server);}
});

it("busy instructions keep frozen text and durable front ordering, then drain as one batch",async()=>{
  const server=await createTestServer();let release:undefined|(()=>void);
  try{
    resetMocks();const token=await loginAndGetToken(server.port),room=await createMockRoom(server.port,token,"Durable queue",["queue-owner"]),id=room.globalMemberIds![0];
    const gate=new Promise<void>(resolve=>release=resolve);let calls=0;mockPromptFn.mockImplementation(async()=>{if(++calls===1)await gate;});
    const post=(content:string)=>jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content}});
    expect((await post("@queue-owner first")).status).toBe(200);await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));
    const second=await post("@queue-owner second original");expect(second.status).toBe(200);const msg=JSON.parse(second.body).message??JSON.parse(second.body);
    expect((await post("@queue-owner third original")).status).toBe(200);
    expect(getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND target_actor_key=? AND status='pending'",room.id,id)?.n).toBe(2);
    patchMessage(room.id,msg.id,{content:"tampered card"});release!();
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));
    const batch=String(mockPromptFn.mock.calls[1][0]);expect(batch).toContain("second original");expect(batch).toContain("third original");expect(batch).not.toContain("tampered card");expect(batch.indexOf("third original")).toBeLessThan(batch.indexOf("second original"));
    await vi.waitFor(()=>expect(getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='settled'",room.id)?.n).toBe(3));
  }finally{release?.();await closeTestServer(server);}
});
it("a failed active prompt does not discard a later accepted instruction",async()=>{
  const server=await createTestServer();let release:undefined|(()=>void);
  try{
    resetMocks();const token=await loginAndGetToken(server.port),room=await createMockRoom(server.port,token,"Failure queue",["failure-owner"]);
    const gate=new Promise<void>(resolve=>release=resolve);let calls=0;mockPromptFn.mockImplementation(async()=>{if(++calls===1){await gate;throw new Error("provider fixture failure");}});
    const post=(content:string)=>jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content}});
    expect((await post("@failure-owner first")).status).toBe(200);await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));
    expect((await post("@failure-owner still deliver this")).status).toBe(200);release!();
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));expect(String(mockPromptFn.mock.calls[1][0])).toContain("still deliver this");
  }finally{release?.();await closeTestServer(server);}
});
it("explicit FYI (no debt) never delivers bare text and fires no note",async()=>{
  const server=await createTestServer();
  try{
    resetMocks();const token=await loginAndGetToken(server.port),room=await createMockRoom(server.port,token,"FYI debt",["fyi-owner"]),id=room.globalMemberIds![0];
    mockPromptFn.mockImplementation(async()=>{emitMockEvent({type:"message_end",text:"do not publish",stopReason:"stop"});});
    postMessage(room.id,"user","@fyi-owner information only",["fyi-owner"],{needResponse:[],needResponseMemberIds:[]});
    await vi.waitFor(()=>expect(getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='settled'",room.id)?.n).toBe(1));
    expect(readMessages(room.id).some(m=>m.senderMemberId===id)).toBe(false);
    expect(readMessages(room.id).some(m=>m.sender==="system"&&String(m.content).includes("finished without replying"))).toBe(false);
    expect(new ReplyObligationRepository(getDatabase()).listPending(room.id,id)).toEqual([]);
  }finally{await closeTestServer(server);}
});
it("a successful chat tool event alone cannot settle debt without a committed own chat",async()=>{
  const server=await createTestServer();
  try{
    resetMocks();const token=await loginAndGetToken(server.port),room=await createMockRoom(server.port,token,"Reply facts",["reply-owner"]),id=room.globalMemberIds![0];
    mockPromptFn.mockImplementation(async()=>{emitMockEvent({type:"tool_end",toolName:"chat_send",isError:false} as any);emitMockEvent({type:"message_end",text:"not a committed chat",stopReason:"stop"});});
    const response=await jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content:"@reply-owner answer"}});expect(response.status,response.body).toBe(200);
    await vi.waitFor(()=>expect(new ReplyObligationRepository(getDatabase()).listPending(room.id,id)).toEqual([]));
    // No committed own chat → nothing is published as the member; the silence note is the only signal.
    expect(readMessages(room.id).some(m=>m.senderMemberId===id)).toBe(false);
    expect(readMessages(room.id).some(m=>m.sender==="system"&&String(m.content).includes("finished without replying"))).toBe(true);
  }finally{await closeTestServer(server);}
});
