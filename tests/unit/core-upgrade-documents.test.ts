import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/data/database.js";
import {coreStorageMigrations} from "../../src/data/schema.js";
import { discoverLegacyInventory } from "../../src/app/upgrade/inventory.js";
import { importLegacyDocuments } from "../../src/app/upgrade/assets.js";
import {getDocument,listDocumentHistory,documentContentMeta,documentSnapshotPath} from "../../src/data/repositories/document-repository.js";
import { type UpgradeImportContext } from "../../src/app/upgrade/inventory.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
function setup(files:Record<string,string>){
 root=mkdtempSync(join(tmpdir(),"upgrade-documents-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);
 for(const [path,value]of Object.entries(files)){const file=join(sourceRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);}
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);
 const entries=discoverLegacyInventory(sourceRoot).entries;const staged=new Map<string,Buffer>();
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(path,bytes){staged.set(path,Buffer.from(bytes));}};
 return {ctx,entries,staged};
}
it("retains exact persona bodies and source-ordered historical revisions",async()=>{
 const path="members/mem_one/persona.md";const body="\ufeff  current 🐟\r\n";
 const history=[{content:" earlier ",ts:1,actorType:"member",actorMemberId:"mem_old",actorName:"retained-label",contentHash:"legacy-short-hash"},{content:"second",ts:2}];
 const {ctx,entries,staged}=setup({[path]:body,"members/mem_one/memory/persona-history.jsonl":history.map(v=>JSON.stringify(v)).join("\n")+"\n"});
 expect((await importLegacyDocuments(ctx,entries,[])).size).toBe(entries.length);
 expect(getDocument(ctx.db,path)?.meta).toMatchObject({revision:2,contentLength:body.length});
 const rows=listDocumentHistory(ctx.db,path);expect(rows.map(r=>staged.get(r.snapshotPath)?.toString())).toEqual(history.map(h=>h.content));
 expect(rows[0]).toMatchObject({actorMemberId:"mem_old",actorName:"retained-label",contentHash:"legacy-short-hash"});
});
it("preserves file revisions independently of history count, including history-only empty current bodies",async()=>{
 const history={scope:"room",revision:3,content:"earlier",ts:1};
 const {ctx,entries,staged}=setup({"rooms/room-one/memory/principles-meta.json":JSON.stringify({room:{revision:8,contentHash:"stored-hash",contentLength:44}}),"rooms/room-one/memory/principles-history.jsonl":JSON.stringify(history)+"\n"});
 await importLegacyDocuments(ctx,entries,[]);const path="rooms/room-one/memory/room-principles.md";
 expect(getDocument(ctx.db,path)?.meta).toMatchObject({revision:8,contentHash:"stored-hash",contentLength:44});
 expect(staged.get(path)).toEqual(Buffer.alloc(0));expect(listDocumentHistory(ctx.db,path).map(r=>r.revision)).toEqual([3]);
});
it("keeps copy-forward bodies separate from current authority",async()=>{
 const {ctx,entries}=setup({"rooms/room-one/prompt-supplements/room.md":"old","rooms/room-one/memory/room-principles.md":"current","rooms/room-one/prompt-supplements/meta.json":JSON.stringify({room:{revision:9}})});
 await importLegacyDocuments(ctx,entries,[]);
 expect(getDocument(ctx.db,"rooms/room-one/prompt-supplements/room.md")?.meta.revision).toBe(9);
 expect(getDocument(ctx.db,"rooms/room-one/memory/room-principles.md")?.meta.revision).toBe(0);
});
it("retires pre-Principles metadata-only bookkeeping without fabricating snapshots or losing body history",async()=>{
 const old={ts:1,scope:"room",revision:1,contentHash:"a".repeat(64),contentLength:12,actorType:"member",actorMemberId:"old-label",operation:"write",note:"old optional note"};
 const modern={scope:"room",revision:9,ts:2,operation:"edit",reason:"retained",content:"actual historical body"};
 const {ctx,entries,staged}=setup({
  "rooms/room-one/memory/room-principles.md":"current body",
  "rooms/room-one/memory/principles-meta.json":JSON.stringify({room:{revision:10}}),
  "rooms/room-one/memory/principles-history.jsonl":[old,{...old,scope:"member",memberId:"retired-label",note:undefined},modern].map(v=>JSON.stringify(v)).join("\n")+"\n",
  "rooms/room-two/prompt-supplements/history.jsonl":JSON.stringify({...old,note:undefined})+"\n",
 });
 expect((await importLegacyDocuments(ctx,entries,[])).size).toBe(entries.length);
 const path="rooms/room-one/memory/room-principles.md";
 const rows=listDocumentHistory(ctx.db,path);expect(rows).toHaveLength(1);expect(rows[0].revision).toBe(9);
 expect(staged.get(rows[0].snapshotPath)?.toString()).toBe(modern.content);
 expect(getDocument(ctx.db,path)?.meta.revision).toBe(10);
 expect(getDocument(ctx.db,"rooms/room-two/prompt-supplements/room.md")).toBeUndefined();
 expect([...staged.values()].map(b=>b.toString())).toEqual([modern.content]);
});
it("does not treat malformed or newer missing-content history as obsolete bookkeeping",async()=>{
 const old={ts:1,scope:"room",revision:1,contentHash:"a".repeat(64),contentLength:12,actorType:"member",operation:"write"};
 for(const event of [{...old,reason:"new format"},{...old,content:null},{...old,contentHash:"invalid"}]){
  const {ctx,entries}=setup({"rooms/room-one/memory/principles-history.jsonl":JSON.stringify(event)+"\n"});
  await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow("Missing historical document body");
  ctx.db.close();rmSync(root!,{recursive:true,force:true});db=undefined;root=undefined;
 }
});
it("rejects missing historical content rather than substituting the current body",async()=>{
 const {ctx,entries}=setup({"members/mem_one/persona.md":"current","members/mem_one/memory/persona-history.jsonl":JSON.stringify({ts:1})+"\n"});
 await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow("Missing historical document body");
 expect(ctx.db.all("SELECT * FROM memory_documents")).toEqual([]);
});
it("rejects legacy subject keys that collide at a sanitized asset path",async()=>{
 const {ctx,entries}=setup({"rooms/room-one/memory/mainline-meta.json":JSON.stringify({members:{"a/b":{revision:1},"a?b":{revision:2}}})});
 await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow("Ambiguous document ownership");
});

it.each([true,false])("reuses only exact history-owned snapshots already published before cutover (%s)",async exact=>{
 const path="members/mem_one/persona.md",content="original revision";
 const snapshot=documentSnapshotPath(path,documentContentMeta(content).contentHash);
 const {ctx,entries,staged}=setup({[path]:"current",[snapshot]:exact?content:"different", "members/mem_one/memory/persona-history.jsonl":JSON.stringify({content,ts:1})+"\n"});
 const live=join(ctx.root,snapshot);mkdirSync(dirname(live),{recursive:true});writeFileSync(live,exact?content:"different");
 const stage=ctx.stageAsset;ctx.stageAsset=(name,bytes)=>{if(ctx.sourceFiles.includes(name))throw new Error("cannot stage a source");stage(name,bytes)};
 if(exact){await importLegacyDocuments(ctx,entries,[]);expect(listDocumentHistory(ctx.db,path)[0].snapshotPath).toBe(snapshot);expect(staged.has(snapshot)).toBe(false)}
 else await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow(/snapshot|Snapshot/);
});
it("reuses published snapshots for sanitized legacy room-document owners on retry",async()=>{
 const content="original revision",path="rooms/room-one/memory/members/old_name/principles.md";
 const snapshot=documentSnapshotPath(path,documentContentMeta(content).contentHash);
 const {ctx,entries,staged}=setup({
  "rooms/room-one/memory/principles-history.jsonl":JSON.stringify({scope:"member",memberId:"old/name",content,ts:1,actorType:"member"})+"\n",
  [snapshot]:content,
 });
 const live=join(ctx.root,snapshot);mkdirSync(dirname(live),{recursive:true});writeFileSync(live,content);
 await importLegacyDocuments(ctx,entries,[]);
 expect(listDocumentHistory(ctx.db,path).map(r=>r.snapshotPath)).toEqual([snapshot]);
 expect(staged.has(snapshot)).toBe(false);
});
