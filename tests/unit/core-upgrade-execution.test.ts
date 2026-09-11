import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/storage/database.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
import {discoverLegacyInventory} from "../../src/storage/legacy-inventory.js";
import {importLegacyExecution} from "../../src/storage/upgrade-execution.js";
import {MembersRepository} from "../../src/storage/repositories/members.js";
import {SessionRepository} from "../../src/storage/repositories/session-repository.js";
import {RuntimeRepository} from "../../src/storage/repositories/runtime-repository.js";
import type {UpgradeImportContext} from "../../src/storage/upgrade-runner.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
function setup(files:Record<string,unknown>){
 root=mkdtempSync(join(tmpdir(),"upgrade-execution-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);
 for(const [path,value]of Object.entries(files)){const file=join(sourceRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));}
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);
 new MembersRepository(db).insert({id:"mem_one",name:"old-label",agentTemplate:"general",global:{},createdAt:1,updatedAt:2,unifiedModel:true,unifiedExtensions:true,scopeOverrides:{}});
 const entries=discoverLegacyInventory(sourceRoot).entries;
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(){throw new Error("unexpected staging");}};
 return {ctx,entries};
}
it("imports application associations without reading or changing SDK history",()=>{
 const session={runtime:"pi",sessionId:"sdk-id",sessionFile:"sessions/2026-09-09/rooms/room-one/sdk.jsonl"};
 const {ctx,entries}=setup({"members/mem_one/sessions/current.json":{"room:room-one":session}});
 const file=join(ctx.root,"members/mem_one",session.sessionFile);mkdirSync(dirname(file),{recursive:true});const body="SDK-owned bytes, deliberately not parsed by the importer\r\n";writeFileSync(file,body);
 expect(importLegacyExecution(ctx,entries).size).toBe(1);
 expect(new SessionRepository(ctx.db).get("mem_one","room-one")?.session).toEqual(session);
 expect(readFileSync(file,"utf8")).toBe(body);expect(entries.some(e=>e.path.endsWith(".jsonl"))).toBe(false);
});
it("does not revive retired room sessions when a current map is explicitly empty",()=>{
 const old={runtime:"pi",sessionFile:"/must/not/open/old.jsonl"};
 const {ctx,entries}=setup({"members/mem_one/sessions/current.json":{},"rooms/room-one/sessions.json":{mem_one:old}});
 importLegacyExecution(ctx,entries);expect(new SessionRepository(ctx.db).get("mem_one","room-one")).toBeUndefined();
 expect(ctx.db.get<{reason:string;record_json:string}>("SELECT reason,record_json FROM execution_import_ambiguities")).toMatchObject({reason:"retired-room-session-generation",record_json:JSON.stringify(old)});
});
it("retains runtime entries by explicit scope/member key without binding old labels",()=>{
 const {ctx,entries}=setup({"rooms/room-one/runtime-state.json":{"room:room-one:mem_one":{contractFingerprint:"old",staleMounts:{since:1,fields:["mcpServers"]}},"room:room-one:old-label":{contractFingerprint:"unresolved"}}});
 importLegacyExecution(ctx,entries);
 expect(new RuntimeRepository(ctx.db).get("room-one","mem_one")).toEqual({contractFingerprint:"old",staleMounts:{since:1,fields:["mcpServers"]}});
 expect(ctx.db.all("SELECT * FROM execution_import_ambiguities")).toHaveLength(1);
});
it("retires background task sources: consumed, never imported, table gone",()=>{
 const taskId="bgt-00000000-0000-4000-8000-000000000001";const path=`members/mem_one/background-tasks/2026-09-09/${taskId}/task.json`;
 const task={taskId,memberId:"mem_one",scopeId:"room:room-one",kind:"generic",sessionMode:"fork",prompt:"private",snapshot:{model:null,credentialId:null,thinkingLevel:null},status:"done",startedAt:"2026-09-09T01:00:00Z",endedAt:"2026-09-09T01:01:00Z",result:" exact result \n",error:null,sessionDir:"/untrusted/old/location",parentSessionRef:"/retained/old/reference.jsonl"};
 const {ctx,entries}=setup({[path]:task});
 const consumed=importLegacyExecution(ctx,entries);
 expect(consumed.has(path)).toBe(true);
 expect(ctx.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_tasks'")).toBeUndefined();
});
it("rejects conflicting canonical associations and escaped file references",()=>{
 const {ctx,entries}=setup({"members/mem_one/sessions/current.json":{"room:room-one":{runtime:"pi",sessionId:"one"},"room-one":{runtime:"pi",sessionId:"two"}}});
 expect(()=>importLegacyExecution(ctx,entries)).toThrow("Conflicting execution source");
});
it("rejects path traversal rather than opening an arbitrary file",()=>{
 const {ctx,entries}=setup({"members/mem_one/sessions/current.json":{"room:room-one":{runtime:"pi",sessionFile:"../../outside.jsonl"}}});
 expect(()=>importLegacyExecution(ctx,entries)).toThrow(/canonical|root/);
});
