import { beforeEach,afterEach,it,expect,vi } from "vitest";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
const control=vi.hoisted(()=>({connections:[] as any[],shellError:false,delayClose:false,delayReady:false,close:[] as (()=>void)[],ready:[] as (()=>void)[]}));
vi.mock("ssh2",async()=>{
  const {EventEmitter}=await import("node:events");
  const {Readable}=await import("node:stream");
  return {Client:class extends EventEmitter{
    destroyed=false;
    constructor(){super();control.connections.push(this);}
    connect(){const ready=()=>this.emit("ready");if(control.delayReady)control.ready.push(ready);else queueMicrotask(ready);return this;}
    destroy(){if(this.destroyed)return;this.destroyed=true;const close=()=>this.emit("close");if(control.delayClose)control.close.push(close);else queueMicrotask(close);}
    end(){this.destroy();}
    shell(_options:any,callback:any){queueMicrotask(()=>callback(new Error("shell refused")));}
    sftp(callback:any){callback(undefined,{createReadStream:()=>Readable.from([Buffer.from("remote fixture")])});}
  }};
});
import { createWorkspace } from "../../src/workspace/workspace-registry.js";
import { workspaceReadTool,dropSftpConnectionsForMember } from "../../src/engine/tools/file-tools.js";
import { createShell,closeAllShellsForMember } from "../../src/engine/shell-manager.js";
import { openRuntimeAdmission,closeRuntimeAdmission } from "../../src/engine/runtime-admission.js";
let fixture:ReturnType<typeof coreFixture>;
beforeEach(()=>{
  fixture=coreFixture();openRuntimeAdmission();
  control.connections=[];control.close=[];control.ready=[];control.delayClose=false;control.delayReady=false;
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_ssh','SSH','ssh','general','{}',0,0)");
  expect(createWorkspace("mem_ssh",{id:"remote",kind:"ssh",host:"test.invalid",user:"fixture",root:"/workspace",keyPath:join(fixture.root,"unused-key")})).toMatchObject({ok:true});
});
afterEach(async()=>{
  control.delayClose=false;for(const close of control.close.splice(0))close();
  await Promise.all([dropSftpConnectionsForMember(),closeAllShellsForMember()]);fixture.close();openRuntimeAdmission();
});
it("concurrent first SFTP calls share one owned connection and cleanup awaits its close event",async()=>{
  const results=await Promise.all([workspaceReadTool("mem_ssh",{path:"a",workspace:"remote"}),workspaceReadTool("mem_ssh",{path:"b",workspace:"remote"})]);
  expect(control.connections).toHaveLength(1);expect(results[0].content[0]).toMatchObject({text:"remote fixture"});
  control.delayClose=true;let finished=false;const closing=dropSftpConnectionsForMember("mem_ssh").then(()=>finished=true);
  await Promise.resolve();expect(finished).toBe(false);expect(control.connections[0].destroyed).toBe(true);
  for(const close of control.close.splice(0))close();await closing;
  expect(finished).toBe(true);
});
it("SFTP readiness cannot reopen admission after archive starts",async()=>{
  control.delayReady=true;const read=workspaceReadTool("mem_ssh",{path:"a",workspace:"remote"});
  await vi.waitFor(()=>expect(control.ready).toHaveLength(1));closeRuntimeAdmission();control.ready.shift()!();
  expect(await read).toMatchObject({content:[{text:"Failed: member runtime admission is closed"}]});await dropSftpConnectionsForMember("mem_ssh");
});
it("failed SSH shell creation retains ownership until its client closes",async()=>{
  control.delayClose=true;let finished=false;
  const creation=createShell({memberId:"mem_ssh",workspace:"remote"}).then(result=>{finished=true;return result;});
  await vi.waitFor(()=>expect(control.close).toHaveLength(1));expect(finished).toBe(false);
  control.close.shift()!();expect(await creation).toMatchObject({ok:false,error:"shell refused"});
  await closeAllShellsForMember("mem_ssh");
});
it("shutdown closes a connecting SSH client before awaiting the blocked shell builder",async()=>{
  control.delayReady=true;const creation=createShell({memberId:"mem_ssh",workspace:"remote"});
  await vi.waitFor(()=>expect(control.ready).toHaveLength(1));closeRuntimeAdmission();
  await closeAllShellsForMember("mem_ssh");expect(await creation).toMatchObject({ok:false});
  expect(control.connections[0].destroyed).toBe(true);
});
