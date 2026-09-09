import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/storage/database.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
import {discoverLegacyInventory} from "../../src/storage/legacy-inventory.js";
import {importLegacyMembers} from "../../src/storage/upgrade-members.js";
import {MembersRepository} from "../../src/storage/repositories/members.js";
import type {UpgradeImportContext} from "../../src/storage/upgrade-runner.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
const member={id:"mem_one",name:"言实",agentTemplate:"general",global:{skills:[],credentialId:null},createdAt:1,updatedAt:2,unifiedModel:true as const,unifiedExtensions:true as const,scopeOverrides:{}};
function setup(files:Record<string,string>){
 root=mkdtempSync(join(tmpdir(),"upgrade-members-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);
 for(const [path,value]of Object.entries(files)){const file=join(sourceRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);}
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);
 const entries=discoverLegacyInventory(sourceRoot).entries;const staged=new Map<string,Buffer>();
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(path,bytes){staged.set(path,Buffer.from(bytes));}};
 return {ctx,entries,staged,repo:new MembersRepository(db)};
}
it("converts header once, preserving identity and literal body while creating its DM scope",()=>{
 const {ctx,entries,staged,repo}=setup({"members/mem_one/member.json":JSON.stringify(member),"members/mem_one/member.md":"\uFEFF---\r\nname: other-label\r\ntitle: Engineer\r\n---\r\n\r\n body \r\n"});
 const imported=importLegacyMembers(ctx,entries,"files");
 expect(repo.get(member.id)).toMatchObject({name:"言实",title:"Engineer",global:member.global});
 expect(staged.get("members/mem_one/persona.md")?.toString()).toBe("\r\n body \r\n");
 expect(imported.personas).toHaveLength(1);expect(imported.consumed.size).toBe(2);
 expect(ctx.db.get("SELECT kind,member_id FROM scopes WHERE id='dm:mem_one'")).toMatchObject({kind:"dm",member_id:member.id});
});
it("uses database authority even when empty and does not parse poison identity leftovers",()=>{
 const {ctx,entries,repo,staged}=setup({"members/mem_one/member.json":"not JSON","members/mem_one/member.md":"---\nbroken"});
 const result=importLegacyMembers(ctx,entries,"database");expect(repo.list()).toEqual([]);expect(staged.size).toBe(0);expect(result.ignoredLegacyPaths).toHaveLength(2);
});
it("never strips YAML-looking bytes from an already converted persona",()=>{
 const {ctx,entries,repo,staged}=setup({"members/mem_one/persona.md":"---\nthis is literal\n---\n"});repo.insert(member);
 importLegacyMembers(ctx,entries,"database");expect(repo.get(member.id)?.name).toBe(member.name);expect(staged.size).toBe(0);
});
it("does not restore missing current persona from a retired profile",()=>{
 const {ctx,entries,repo}=setup({"members/mem_one/member.md":"old content"});repo.insert(member);
 expect(()=>importLegacyMembers(ctx,entries,"database")).toThrow("Missing snapshotted member source");
});
it("rolls back all imported identities when names conflict",()=>{
 const {ctx,entries,repo}=setup({"members/mem_one/member.json":JSON.stringify(member),"members/mem_two/member.json":JSON.stringify({...member,id:"mem_two"})});
 expect(()=>importLegacyMembers(ctx,entries,"files")).toThrow();expect(repo.list()).toEqual([]);expect(ctx.db.all("SELECT * FROM scopes")).toEqual([]);
});
it("rejects profile-only input and file services inside an ambient transaction",()=>{
 const {ctx,entries}=setup({"members/mem_one/member.md":"orphan"});
 expect(()=>importLegacyMembers(ctx,entries,"files")).toThrow("no identity metadata");
 expect(()=>ctx.db.transaction(()=>importLegacyMembers(ctx,entries,"files"))).toThrow(/outside|transaction/i);
});
