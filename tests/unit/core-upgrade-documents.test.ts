import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/storage/database.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
import {discoverLegacyInventory} from "../../src/storage/legacy-inventory.js";
import {importLegacyDocuments} from "../../src/storage/upgrade-documents.js";
import {getDocument,listDocumentHistory} from "../../src/storage/document-repository.js";
import type {UpgradeImportContext} from "../../src/storage/upgrade-runner.js";
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
it("rejects missing historical content rather than substituting the current body",async()=>{
 const {ctx,entries}=setup({"members/mem_one/persona.md":"current","members/mem_one/memory/persona-history.jsonl":JSON.stringify({ts:1})+"\n"});
 await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow("Missing historical document body");
 expect(ctx.db.all("SELECT * FROM memory_documents")).toEqual([]);
});
it("rejects legacy subject keys that collide at a sanitized asset path",async()=>{
 const {ctx,entries}=setup({"rooms/room-one/memory/mainline-meta.json":JSON.stringify({members:{"a/b":{revision:1},"a?b":{revision:2}}})});
 await expect(importLegacyDocuments(ctx,entries,[])).rejects.toThrow("Ambiguous document ownership");
});
