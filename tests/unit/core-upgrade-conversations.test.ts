import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/storage/database.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
import {discoverLegacyInventory} from "../../src/storage/legacy-inventory.js";
import {importLegacyConversations} from "../../src/storage/upgrade-conversations.js";
import {readMessages,readArchivedMessages,appendMessageInTransaction} from "../../src/storage/message-repository.js";
import {ConversationsRepository} from "../../src/storage/repositories/conversations.js";
import {TasksRepository} from "../../src/storage/repositories/tasks.js";
import {UserCursorRepository} from "../../src/storage/repositories/user-cursor-repository.js";
import {prepareStorageUpgrade,type UpgradeImportContext} from "../../src/storage/upgrade-runner.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
const room={id:"room-one",name:"Room",members:["historic"],globalMemberIds:[],createdAt:1};
const message={id:"msg-one",seq:3,ts:2,sender:"old-label",content:"retained",mentions:[],needResponseMemberIds:[]};
function filesAt(base:string,files:Record<string,string>){for(const [path,value]of Object.entries(files)){const file=join(base,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,value);}}
function setup(files:Record<string,string>){
 root=mkdtempSync(join(tmpdir(),"upgrade-conversations-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);filesAt(sourceRoot,files);
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);
 const entries=discoverLegacyInventory(sourceRoot).entries;
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(){throw new Error("unexpected body");}};
 return {ctx,entries};
}
it("preserves room/topic/DM facts, explicit empty rosters, task history and independent cursors",async()=>{
 const topic={id:"topic-one",roomId:room.id,title:"Topic",anchorMessageId:message.id,createdBy:"old-label",createdAt:3,status:"active",seedMode:"fresh",participants:[]};
 const task={id:"task-one",roomId:room.id,title:"Task",status:"todo",priority:"P1",createdBy:"historic",createdAt:1,updatedAt:2,assignee:"old-label",subscriberMemberIds:[],subscribers:["old-label"],comments:[{id:"c1",author:"historic",content:"literal",createdAt:1}]};
 const {ctx,entries}=setup({
  "rooms/room-one/room.json":JSON.stringify(room),"rooms/room-one/tasks.json":JSON.stringify([task]),
  "rooms/room-one/messages.jsonl":JSON.stringify(message)+"\n","rooms/room-one/.seq":"20",
  "rooms/room-one/cursors.json":JSON.stringify({"legacy-label":message.id}),
  "rooms/room-one/topics/topic-one/topic.json":JSON.stringify(topic),
  "rooms/room-one/topics/topic-one/messages.jsonl":JSON.stringify({...message,id:"topic-message"})+"\n",
  "members/mem_one/dm-messages.jsonl":JSON.stringify({...message,id:"dm-message"})+"\n",
  "members/mem_one/dm-cursor.json":JSON.stringify({messageId:"dangling",seq:7}),
  "user-read-cursors.json":JSON.stringify({"room:room-one":{messageId:message.id,seq:3,updatedAt:10}}),
 });
 const consumed=await importLegacyConversations(ctx,entries);expect(consumed.size).toBe(entries.length);
 expect(new ConversationsRepository(ctx.db).getRoom(room.id)).toMatchObject(room);
 expect(new ConversationsRepository(ctx.db).getTopic(room.id,topic.id)).toEqual(topic);
 expect(readMessages(room.id,ctx.db)).toEqual([message]);expect(readMessages("dm:mem_one",ctx.db)[0].id).toBe("dm-message");
 expect(readMessages("topic:topic-one",ctx.db)[0].id).toBe("topic-message");
 expect(new TasksRepository(ctx.db).get(room.id,task.id)).toMatchObject(task);
 expect(new UserCursorRepository(ctx.db).get(room.id)?.updatedAt).toBe(10);
 expect(ctx.db.all("SELECT * FROM outbox")).toEqual([]);
 expect(appendMessageInTransaction(ctx.db,room.id,{sender:"user",content:"next",mentions:[]}).seq).toBe(20);
});
it("retains original nonblank event order, unknown event kinds and archived messages without activation",async()=>{
 const events=[{type:"agent_start",ts:1},{type:"message_delta",value:"retained"},{type:"agent_end",ts:4}];
 const {ctx,entries}=setup({"rooms/room-one/room.json":JSON.stringify(room),"rooms/room-one/agent-events/old-label.jsonl":"\n"+events.map(e=>JSON.stringify(e)).join("\n\n")+"\n","rooms/room-one/archives/123.jsonl":JSON.stringify(message)+"\n","rooms/room-one/agent-events/old-label.stats.json":"invalid derived cache"});
 await importLegacyConversations(ctx,entries);
 expect(ctx.db.all<{seq:number;member_id:null;payload_json:string}>("SELECT seq,member_id,payload_json FROM agent_events ORDER BY seq").map(r=>({seq:r.seq,memberId:r.member_id,event:JSON.parse(r.payload_json)}))).toEqual(events.map((event,i)=>({seq:i+1,memberId:null,event})));
 expect(readArchivedMessages(room.id,123,ctx.db)).toEqual([message]);expect(ctx.db.all("SELECT * FROM outbox")).toEqual([]);
});
it("preserves empty archives and independent summary metadata",async()=>{
 const summary={summary:"retained",archivedCount:2,range:["old-one","old-two"],ts:123};
 const {ctx,entries}=setup({"rooms/room-one/archives/123.jsonl":"", "rooms/room-one/archives/123.summary.json":JSON.stringify(summary)});
 expect((await importLegacyConversations(ctx,entries)).size).toBe(2);
 expect(ctx.db.get("SELECT archive_ts,has_messages,summary_json FROM message_archives")).toEqual({archive_ts:123,has_messages:1,summary_json:JSON.stringify(summary)});
});
it("does not turn an ID-shaped event filename into a current member identity",async()=>{
 const {ctx,entries}=setup({"rooms/room-one/agent-events/mem_one.jsonl":JSON.stringify({type:"agent_end",ts:2})+"\n"});
 ctx.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_one','new-label','new-label','general','{}',1,1)");
 await importLegacyConversations(ctx,entries);
 expect(ctx.db.get("SELECT owner_key,member_id FROM agent_events")).toEqual({owner_key:"legacy-unresolved:mem_one",member_id:null});
});
it("rejects path ownership mismatches",async()=>{
 const {ctx,entries}=setup({"rooms/room-one/room.json":JSON.stringify({...room,id:"other"})});
 await expect(importLegacyConversations(ctx,entries)).rejects.toThrow("ownership mismatch");
});
it("does not cut over when a later malformed line follows committed staging batches",async()=>{
 root=mkdtempSync(join(tmpdir(),"upgrade-conversation-failure-"));
 filesAt(root,{"rooms/room-one/room.json":JSON.stringify(room),"rooms/room-one/agent-events/old-label.jsonl":Array.from({length:130},(_,i)=>JSON.stringify({type:"message_delta",ts:i})).join("\n")+"\n{bad}\n"});
 const entries=discoverLegacyInventory(root).entries;
 await expect(prepareStorageUpgrade({root,formatVersion:1,migrations:coreStorageMigrations,collectLegacySources:async()=>entries,importData:async ctx=>{await importLegacyConversations(ctx,entries);},validate:async()=>{throw new Error("must not validate");}})).rejects.toThrow();
 expect(existsSync(join(root,"bossmode.db"))).toBe(false);expect(existsSync(join(root,"rooms/room-one/room.json"))).toBe(true);
});
