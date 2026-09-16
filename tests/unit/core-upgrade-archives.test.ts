import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,bindDatabase,type Database} from "../../src/data/database.js";
import {coreStorageMigrations} from "../../src/data/migrations.js";
import {discoverLegacyInventory} from "../../src/data/upgrade/legacy-inventory.js";
import {importLegacyArchives} from "../../src/data/upgrade/upgrade-archives.js";
import {MembersRepository} from "../../src/data/repositories/members.js";
import {MemberArchivesRepository} from "../../src/data/repositories/member-archives.js";
import {getConversationMember} from "../../src/data/repositories/conversations.js";
import type {UpgradeImportContext} from "../../src/data/upgrade/upgrade-runner.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
function setup(files:Record<string,string>){
 root=mkdtempSync(join(tmpdir(),"upgrade-archives-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);
 for(const [path,value]of Object.entries(files)){const file=join(sourceRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);}
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);bindDatabase(db);
 const entries=discoverLegacyInventory(sourceRoot).entries;
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(){throw new Error("Archive backups must not be rewritten");}};
 return {ctx,entries};
}
const archive="backups/fired-old-2026-09-09T00-00-00-000Z";
const record={id:"mem_old",name:"reused-name",agentTemplate:"general",global:{},createdAt:1,updatedAt:2,unifiedModel:true,unifiedExtensions:true,scopeOverrides:{}};
it("retains a fired ID without making it active or assigning the current reused name",()=>{
 const {ctx,entries}=setup({[`${archive}/member.json`]:JSON.stringify(record),[`${archive}/member.md`]:'---\ntitle: Old title\n---\n  old body\r\n'});
 const members=new MembersRepository(ctx.db);members.insert({...record,id:"mem_current"});
 expect(importLegacyArchives(ctx,entries).size).toBe(entries.length);
 expect(members.list().map(m=>m.id)).toEqual(["mem_current"]);expect(members.getRetained("mem_old")?.name).toBe("reused-name");
 expect(getConversationMember("mem_old")).toBeNull();
 expect(new MemberArchivesRepository(ctx.db).get(archive,"reused-name")).toMatchObject({memberId:"mem_old",personaFormat:"frontmatter",hasPersona:true,title:"Old title"});
});
it("relocates only manifest references present in the verified snapshot inventory",()=>{
 const dir="backups/legacy-test";const body=`${dir}/rooms/room-one/memory/members/old/principles.md`;
 const {ctx,entries}=setup({[`${dir}/manifest.json`]:JSON.stringify({members:[{name:"old",principlesPath:"/old/data/rooms/room-one/memory/members/old/principles.md"},{name:"missing",principlesPath:"/must/not/open/secrets.md"}]}),[body]:"retained body"});
 importLegacyArchives(ctx,entries);const catalog=new MemberArchivesRepository(ctx.db);
 expect(catalog.get(dir,"old")).toMatchObject({personaPath:body,hasPersona:true});
 expect(catalog.get(dir,"missing")?.personaPath).toBeUndefined();expect(catalog.get(dir,"missing")?.hasPersona).toBe(false);
});
it("does not turn a backup snapshot of a still-live ID into its archive authority",()=>{
 const {ctx,entries}=setup({[`${archive}/member.json`]:JSON.stringify(record)});const members=new MembersRepository(ctx.db);members.insert(record);
 importLegacyArchives(ctx,entries);expect(members.get("mem_old")).not.toBeNull();expect(new MemberArchivesRepository(ctx.db).get(archive,record.name)?.memberId).toBeUndefined();
});
it("refuses ambiguous physical locations for one archived ID",()=>{
 const second="backups/fired-copy-2026-09-09T01-00-00-000Z";
 const {ctx,entries}=setup({[`${archive}/member.json`]:JSON.stringify(record),[`${second}/member.json`]:JSON.stringify(record)});
 expect(()=>importLegacyArchives(ctx,entries)).toThrow("Conflicting archived identity locations");
});
