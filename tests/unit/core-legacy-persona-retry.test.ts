import {it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {prepareStorageUpgrade,type UpgradeOptions} from "../../src/storage/upgrade-runner.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
import {discoverLegacyInventory} from "../../src/storage/legacy-inventory.js";
import {importLegacyMembers} from "../../src/storage/upgrade-members.js";
import {importLegacyDocuments} from "../../src/storage/upgrade-documents.js";
import {listDocumentHistory,documentSnapshotPath,documentContentMeta} from "../../src/storage/document-repository.js";
it("ordinary coordinator retry reuses published older-persona history without replacing source bodies",async()=>{
 const root=mkdtempSync(join(tmpdir(),"legacy-persona-retry-"));let db:Awaited<ReturnType<typeof prepareStorageUpgrade>>["db"]|undefined;
 const path="members/mem_one/persona.md",current="  exact current\r\n",previous="earlier revision\n";
 const member={id:"mem_one",name:"Person",agentTemplate:"general",global:{skills:[],credentialId:null},createdAt:1,updatedAt:2,unifiedModel:true,unifiedExtensions:true,scopeOverrides:{}};
 const files={"members/mem_one/member.json":JSON.stringify(member),"members/mem_one/memory/persona.md":current,"members/mem_one/memory/persona-history.jsonl":JSON.stringify({content:previous,ts:1})+"\n"};
 try{
  for(const [name,value]of Object.entries(files)){mkdirSync(dirname(join(root,name)),{recursive:true});writeFileSync(join(root,name),value)}
  const options:UpgradeOptions={root,formatVersion:1,migrations:coreStorageMigrations,collectLegacySources:async r=>discoverLegacyInventory(r).entries,importData:async ctx=>{const entries=discoverLegacyInventory(ctx.sourceRoot).entries;const members=importLegacyMembers(ctx,entries,"files");await importLegacyDocuments(ctx,entries,members.personas)},validate:async()=>{}};
  await expect(prepareStorageUpgrade({...options,checkpoint:phase=>{if(phase==="validated")throw new Error("after asset publication")}})).rejects.toThrow("after asset publication");
  const snapshot=documentSnapshotPath(path,documentContentMeta(previous).contentHash);
  expect(readFileSync(join(root,path),"utf8")).toBe(current);expect(readFileSync(join(root,snapshot),"utf8")).toBe(previous);
  const result=await prepareStorageUpgrade(options);db=result.db;
  expect(listDocumentHistory(db,path)).toHaveLength(1);expect(readFileSync(join(root,snapshot),"utf8")).toBe(previous);
  expect(readFileSync(join(root,path),"utf8")).toBe(current);
 }finally{db?.close();rmSync(root,{recursive:true,force:true})}
});
