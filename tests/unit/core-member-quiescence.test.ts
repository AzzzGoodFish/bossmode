import { mainSessionDirectory } from "../../src/files/layout.js";
import { expect, it, vi } from "vitest";
import { existsSync,mkdirSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestServer,closeTestServer,createMockRoom,loginAndGetToken,jsonRequest,setupTestWorkspace,getTestBossmodeDir } from "../helpers/test-server.js";
import { buildMemberAgentSession,getRegistry,shutdownAll,destroyInstance,resetAgentSession } from "../../src/agent/orchestrator/agent-manager.js";
import { getDatabase } from "../../src/data/database.js";
import { createShell } from "../../src/agent/terminal/shell-manager.js";
setupTestWorkspace();

it("DELETE closes admission before awaiting a pending builder and archives only after its handle is released", async()=>{
  const server=await createTestServer();let release!:()=>void;
  try {
    const token=await loginAndGetToken(server.port);
    const room=await createMockRoom(server.port,token,"Archive boundary",["pending-archive"]);const id=room.globalMemberIds![0];
    expect((await jsonRequest(server.port,"DELETE",`/api/members/${id}`,{token,body:{confirm:false}})).status).toBe(400);
    let entered=false;const gate=new Promise<void>(resolve=>release=resolve);
    const runtime=getRegistry()!.get("pi-cli")!;const original=runtime.createAgent.bind(runtime);
    let handle:any;
    vi.spyOn(runtime,"createAgent").mockImplementationOnce(async args=>{entered=true;await gate;handle=await original(args);vi.spyOn(handle,"destroyAndWait");return handle;});
    const build=buildMemberAgentSession(id,`room:${room.id}`);
    await vi.waitFor(()=>expect(entered).toBe(true));
    const removal=jsonRequest(server.port,"DELETE",`/api/members/${id}`,{token,body:{confirm:true}});
    await vi.waitFor(()=>expect(getDatabase().get("SELECT 1 FROM member_archive_intents WHERE member_id=? AND state='pending'",id)).toBeTruthy());
    expect(await buildMemberAgentSession(id,`dm:${id}`)).toBeNull();
    expect((await createShell({memberId:id})).ok).toBe(false);
    expect(existsSync(join(getTestBossmodeDir(),"members",id))).toBe(true);
    release();await build;
    const result=await removal;expect(result.status,result.body).toBe(200);
    expect(handle.destroyAndWait).toHaveBeenCalled();
    const archived=JSON.parse(result.body).archived;
    expect(existsSync(join(getTestBossmodeDir(),"members",id))).toBe(false);
    expect(existsSync(join(getTestBossmodeDir(),archived,"persona.md"))).toBe(true);
    expect((await jsonRequest(server.port,"GET",`/api/members/${id}`,{token})).status).toBe(404);
    const reused=await jsonRequest(server.port,"POST","/api/members",{token,body:{name:"pending-archive"}});
    expect(reused.status,reused.body).toBe(200);expect(JSON.parse(reused.body).member.memberId).not.toBe(id);
  }finally{release?.();vi.restoreAllMocks();await closeTestServer(server);}
});

it("global shutdown retains reset builders and rejects new creation",async()=>{
  const server=await createTestServer();let release!:()=>void;
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Shutdown boundary",["pending-shutdown"]);const id=room.globalMemberIds![0];
    const runtime=getRegistry()!.get("pi-cli")!;const create=runtime.createAgent.bind(runtime);
    let entered=false;const gate=new Promise<void>(resolve=>release=resolve);
    vi.spyOn(runtime,"createAgent").mockImplementationOnce(async args=>{entered=true;await gate;return create(args);});
    const build=buildMemberAgentSession(id,`room:${room.id}`);await vi.waitFor(()=>expect(entered).toBe(true));
    destroyInstance(`room:${room.id}`,id);
    const shutdownSpy=vi.spyOn(runtime,"shutdownAll");let finished=false;
    const stopping=shutdownAll().then(()=>{finished=true;});
    expect(await buildMemberAgentSession(id,`dm:${id}`)).toBeNull();expect(finished).toBe(false);expect(shutdownSpy).not.toHaveBeenCalled();
    release();await build;await stopping;expect(shutdownSpy).toHaveBeenCalledOnce();expect(finished).toBe(true);
  }finally{release?.();vi.restoreAllMocks();await closeTestServer(server);}
});

it.each(["room","dm"])("reset rejects a delayed %s creator's old session publication",async(kind)=>{
  const server=await createTestServer();let release!:()=>void;
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,`References ${kind}`,[`reference-${kind}`]);const id=room.globalMemberIds![0];
    const scope=kind==="dm"?`dm:${id}`:`room:${room.id}`;
    const sessions=await import("../../src/member/sessions.js");
    const directory=mainSessionDirectory(id);mkdirSync(directory,{recursive:true});const file=join(directory,"old.jsonl");writeFileSync(file,"retained SDK history\n");
    sessions.saveCurrentSession(id,{runtime:"pi-cli",sessionId:"old",sessionFile:file});
    const runtime=getRegistry()!.get("pi-cli")!;const original=runtime.createAgent.bind(runtime);
    let entered=false;const gate=new Promise<void>(resolve=>release=resolve);
    const create=vi.spyOn(runtime,"createAgent").mockImplementationOnce(async args=>{
      expect(args.resumeSession?.sessionId).toBe("old");entered=true;await gate;
      args.onSessionChanged?.({sessionId:"old",sessionFile:file});return original(args);
    });
    const creating=buildMemberAgentSession(id,scope);await vi.waitFor(()=>expect(entered).toBe(true));
    resetAgentSession(kind==="room"?room.id:scope,id);release();expect(await creating).toBeNull();
    expect(sessions.getCurrentSession(id)).toBeUndefined();expect(existsSync(file)).toBe(true);
    expect(await buildMemberAgentSession(id,scope)).toBeTruthy();expect(create.mock.calls[1][0].resumeSession).toBeUndefined();
  }finally{release?.();vi.restoreAllMocks();await closeTestServer(server);}
});

it("reset cancels a detached member's work so the member can be archived",async()=>{
  const server=await createTestServer();
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Detached reset",["detached-member","idle-peer"]);const [id]=room.globalMemberIds!;
    const instance=(await buildMemberAgentSession(id,`room:${room.id}`))!;
    const abort=vi.spyOn(instance.handle,"abort");
    resetAgentSession(room.id,id);
    expect(abort).toHaveBeenCalled();
    const removal=await jsonRequest(server.port,"DELETE",`/api/members/${id}`,{token,body:{confirm:true}});expect(removal.status,removal.body).toBe(200);
  }finally{vi.restoreAllMocks();await closeTestServer(server);}
});

it("shutdown preserves final session metadata from an already owned run",async()=>{
  const server=await createTestServer();
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Final session metadata",["final-session"]);const id=room.globalMemberIds![0];
    const runtime=getRegistry()!.get("pi-cli")!;const create=vi.spyOn(runtime,"createAgent");
    await buildMemberAgentSession(id,`room:${room.id}`);
    const sessions=await import("../../src/member/sessions.js");const directory=mainSessionDirectory(id);
    mkdirSync(directory,{recursive:true});const file=join(directory,"final.jsonl");writeFileSync(file,"retained SDK history\n");
    const stopping=shutdownAll();
    create.mock.calls[0][0].onSessionChanged?.({sessionId:"final",sessionFile:file});
    await stopping;expect(sessions.getCurrentSession(id)?.sessionId).toBe("final");
  }finally{vi.restoreAllMocks();await closeTestServer(server);}
});

it("shutdown waits for the application prompt continuation beyond a runtime's idle report",async()=>{
  const server=await createTestServer();let release!:()=>void;
  const mock=await import("../helpers/mock-runtime.js");
  try{
    const token=await loginAndGetToken(server.port);const room=await createMockRoom(server.port,token,"Application drain",["application-drain"]);const id=room.globalMemberIds![0];
    let entered=false;const gate=new Promise<void>(resolve=>release=resolve);
    mock.setMockPromptFn(vi.fn(async()=>{entered=true;await gate;}));
    const {addMessage}=await import("../../src/chat/message-store.js");
    addMessage(room.id,{sender:"user",content:"finish this work",mentions:[],mentionMemberIds:[id]});
    const {activateAgent}=await import("../../src/agent/orchestrator/agent-manager.js");const activation=activateAgent(room.id,id);
    await vi.waitFor(()=>expect(entered).toBe(true));let finished=false;
    const stopping=shutdownAll().then(()=>finished=true);
    await new Promise(resolve=>setTimeout(resolve,20));expect(finished).toBe(false);
    release();await activation;await stopping;expect(finished).toBe(true);
  }finally{release?.();mock.setMockPromptFn(vi.fn().mockResolvedValue(undefined));vi.restoreAllMocks();await closeTestServer(server);}
});
