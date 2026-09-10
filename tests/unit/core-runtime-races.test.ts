import {it,expect,vi} from "vitest";
import {setupTestWorkspace,createTestServer,closeTestServer,createMockRoom,loginAndGetToken,jsonRequest} from "../helpers/test-server.js";
import {resetMocks,mockPromptFn,mockAbortFn,MockRuntime,emitMockEvent} from "../helpers/mock-runtime.js";
import {resetAgentSession,reloadMemberSession,shutdownAll,initAgentManager,resumePendingRuntimeInputs} from "../../src/engine/agent-manager.js";
import {RuntimeRegistry} from "../../src/engine/runtime/registry.js";
import {getDatabase} from "../../src/storage/database.js";
import {ReplyObligationRepository} from "../../src/storage/repositories/reply-obligation-repository.js";
import {readMessages} from "../../src/storage/message-repository.js";
import {postMessage} from "../../src/communication/message-bus.js";
import * as tools from "../../src/engine/tools.js";
setupTestWorkspace();
const barrier=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
async function fixture(){const server=await createTestServer();resetMocks();const token=await loginAndGetToken(server.port),room=await createMockRoom(server.port,token,"Runtime races",["race-owner"]),id=room.globalMemberIds![0];return {server,room,id,post:(text:string)=>jsonRequest(server.port,"POST",`/api/rooms/${room.id}/messages`,{token,body:{content:`@race-owner ${text}`}})};}
const debts=(room:string,id:string)=>new ReplyObligationRepository(getDatabase()).listPending(room,id);
it("delivery after reset waits for the old prompt, then starts a fresh instance",async()=>{
  const f=await fixture(),gate=barrier();let count=0;
  try{
    mockPromptFn.mockImplementation(async()=>{if(++count===1)await gate.promise;});
    await f.post("old request");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));
    resetAgentSession(f.room.id,f.id);await f.post("new after reset");expect(mockPromptFn).toHaveBeenCalledTimes(1);
    gate.release();await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));expect(String(mockPromptFn.mock.calls[1][0])).toContain("new after reset");
  }finally{gate.release();await closeTestServer(f.server);}
});
it("an obsolete rejected builder cannot cancel post-reset delivery",async()=>{
  const f=await fixture(),gate=barrier(),original=MockRuntime.prototype.createAgent;let creations=0;
  const spy=vi.spyOn(MockRuntime.prototype,"createAgent").mockImplementation(async function(opts){if(++creations===1)await gate.promise;return original.call(this,opts);});
  try{
    await f.post("old builder");await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(1));
    resetAgentSession(f.room.id,f.id);await f.post("new builder request");gate.release();
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));expect(String(mockPromptFn.mock.calls[0][0])).toContain("new builder request");
    expect(getDatabase().all<{diagnosis:string}>("SELECT diagnosis FROM queued_inputs WHERE scope_id=? AND status='interrupted'",f.room.id).every(row=>row.diagnosis!=="runtime creation failed")).toBe(true);
  }finally{gate.release();spy.mockRestore();await closeTestServer(f.server);}
});
it("shutdown during creation preserves a safe pending input and restart can execute it",async()=>{
  const f=await fixture(),gate=barrier(),original=MockRuntime.prototype.createAgent;let creations=0;
  const spy=vi.spyOn(MockRuntime.prototype,"createAgent").mockImplementation(async function(opts){if(++creations===1)await gate.promise;return original.call(this,opts);});
  try{
    await f.post("survives shutdown");await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(1));
    const stop=shutdownAll();gate.release();await stop;
    expect(getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='pending'",f.room.id)?.n).toBe(1);expect(debts(f.room.id,f.id)).toHaveLength(1);expect(mockPromptFn).not.toHaveBeenCalled();
    const registry=new RuntimeRegistry();registry.register(new MockRuntime("pi-cli"));initAgentManager(registry);resumePendingRuntimeInputs();
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));expect(String(mockPromptFn.mock.calls[0][0])).toContain("survives shutdown");
  }finally{gate.release();spy.mockRestore();await closeTestServer(f.server);}
});
it.each(["length","error","silent"])("a %s continuation closes the original obligation without fabricating a reply",async end=>{
  const f=await fixture();let count=0;
  try{
    mockPromptFn.mockImplementation(async()=>{if(++count===1)emitMockEvent({type:"message_end",text:"partial",stopReason:"length"});else emitMockEvent({type:"message_end",text:"",stopReason:end==="silent"?"stop":end,...(end==="error"?{errorMessage:"fixture provider error"}:{})});});
    await f.post("complete this");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(()=>expect(debts(f.room.id,f.id)).toEqual([]));expect(readMessages(f.room.id).some(m=>m.senderMemberId===f.id)).toBe(false);
  }finally{await closeTestServer(f.server);}
});
it("a length-truncated FYI continuation does not acquire reply debt or auto-publish text",async()=>{
  const f=await fixture();let count=0;
  try{
    mockPromptFn.mockImplementation(async()=>{emitMockEvent({type:"message_end",text:++count===1?"partial":"not a reply",stopReason:count===1?"length":"stop"});});
    postMessage(f.room.id,"user","@race-owner FYI",["race-owner"],{needResponse:[],needResponseMemberIds:[]});
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));await vi.waitFor(()=>expect(getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='settled'",f.room.id)?.n).toBe(2));
    expect(debts(f.room.id,f.id)).toEqual([]);expect(readMessages(f.room.id).some(m=>m.senderMemberId===f.id)).toBe(false);
  }finally{await closeTestServer(f.server);}
});
it("publication failure closes the workflow as failed, without replaying successful SDK work",async()=>{
  const f=await fixture();const spy=vi.spyOn(tools,"deliverMemberMessage").mockImplementationOnce(()=>{throw new Error("publication fixture failure");});
  try{
    mockPromptFn.mockImplementation(async()=>emitMockEvent({type:"message_end",text:"finished result",stopReason:"stop"}));
    await f.post("reply");await vi.waitFor(()=>expect(getDatabase().get<{outcome:string}>("SELECT outcome FROM queued_inputs WHERE scope_id=?",f.room.id)?.outcome).toBe("failed"));
    expect(debts(f.room.id,f.id)).toEqual([]);expect(mockPromptFn).toHaveBeenCalledTimes(1);expect(readMessages(f.room.id).some(m=>m.content.includes("publication fixture failure"))).toBe(true);
  }finally{spy.mockRestore();await closeTestServer(f.server);}
});

it("a deferred reload rechecks admission and never tears down a new turn",async()=>{
  const f=await fixture(),first=barrier(),second=barrier();let calls=0;
  const callbacks:Array<()=>void>=[],originalTimer=globalThis.setTimeout;
  const timer=vi.spyOn(globalThis,"setTimeout").mockImplementation(((callback:any,delay?:number,...args:any[])=>{
    if(delay===0){callbacks.push(()=>callback(...args));return originalTimer(()=>{},0);}
    return originalTimer(callback,delay,...args);
  }) as any);
  const create=vi.spyOn(MockRuntime.prototype,"createAgent");
  try{
    mockPromptFn.mockImplementation(async()=>{await (++calls===1?first.promise:second.promise);});
    await f.post("first");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));
    expect(await reloadMemberSession(`room:${f.room.id}`,f.id,"deferred test")).toMatchObject({queued:true});
    first.release();await vi.waitFor(()=>expect(callbacks.length).toBeGreaterThan(0));
    await f.post("new turn before reload timer");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));mockAbortFn.mockClear();
    for(const callback of callbacks.splice(0))callback();await new Promise<void>(resolve=>setImmediate(resolve));
    expect(mockAbortFn).not.toHaveBeenCalled();expect(create).toHaveBeenCalledTimes(1);
  }finally{timer.mockRestore();create.mockRestore();first.release();second.release();await closeTestServer(f.server);}
});

it.each(["stop","length"])("queued FYI during post-run compaction cannot orphan a %s batch's reply",async stopReason=>{
  const f=await fixture(),gate=barrier();let calls=0;
  try{
    mockPromptFn.mockImplementation(async()=>{
      if(++calls===1){emitMockEvent({type:"message_end",text:"original completed result",stopReason});emitMockEvent({type:"agent_end"});emitMockEvent({type:"compaction_start",reason:"threshold"});await gate.promise;emitMockEvent({type:"compaction_end",reason:"threshold"});}
      else emitMockEvent({type:"message_end",text:"continued result",stopReason:"stop"});
    });
    await f.post("reply required");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));mockAbortFn.mockClear();
    postMessage(f.room.id,"user","@race-owner subsequent FYI",["race-owner"],{needResponse:[],needResponseMemberIds:[]});expect(mockAbortFn).not.toHaveBeenCalled();gate.release();
    await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(2));await vi.waitFor(()=>expect(debts(f.room.id,f.id)).toEqual([]));
    const own=readMessages(f.room.id).filter(m=>m.senderMemberId===f.id);expect(own).toHaveLength(1);expect(own[0].content).toBe(stopReason==="stop"?"original completed result":"continued result");
  }finally{gate.release();await closeTestServer(f.server);}
});

it("failed creation does not automatically repeat external initialization",async()=>{
  const f=await fixture();const create=vi.spyOn(MockRuntime.prototype,"createAgent").mockRejectedValue(new Error("broken runtime builder"));
  try{
    await f.post("creation fails once");await vi.waitFor(()=>expect(getDatabase().get<{status:string}>("SELECT status FROM queued_inputs WHERE scope_id=?",f.room.id)?.status).toBe("interrupted"));
    await new Promise<void>(resolve=>setImmediate(resolve));expect(create).toHaveBeenCalledTimes(1);expect(mockPromptFn).not.toHaveBeenCalled();expect(debts(f.room.id,f.id)).toEqual([]);
    expect(readMessages(f.room.id).some(m=>m.content.includes("broken runtime builder"))).toBe(true);
    create.mockRestore();await f.post("explicit new request");await vi.waitFor(()=>expect(mockPromptFn).toHaveBeenCalledTimes(1));
  }finally{create.mockRestore();await closeTestServer(f.server);}
});
