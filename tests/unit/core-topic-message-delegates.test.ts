import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import { importMessage, importAgentEvent } from "../../src/storage/messages-import.js";
import { readMessages } from "../../src/storage/message-repository.js";
import { readAgentEvents } from "../../src/storage/event-repository.js";
import * as topics from "../../src/workspace/topic-store.js";
import * as rooms from "../../src/workspace/room-store.js";
import { readAllDmMessages } from "../../src/workspace/dm-message-store.js";
import { readAllMessages } from "../../src/workspace/message-store.js";
import { loadEventsFromDisk, loadEventsPaginated } from "../../src/engine/event-handler.js";
const location=vi.hoisted(()=>({root:process.env.BOSSMODE_TEST_ROOT!}));
vi.mock("../../src/shared/config.js",async importOriginal=>({...await importOriginal<typeof import("../../src/shared/config.js")>(),getBossmodeDir:()=>location.root}));
let f:ReturnType<typeof conversationsFixture>;
beforeEach(()=>{
 location.root=process.env.BOSSMODE_TEST_ROOT!;f=conversationsFixture();location.root=f.root;f.room("r");f.room("other");f.member("mem_one","Alice");f.repository().ensureDmScope("mem_one");
 f.repository().upsertTopic({id:"t",roomId:"r",title:"Topic",anchorMessageId:"anchor",createdBy:"user",createdAt:0,status:"active",seedMode:"fresh",participants:[]});
});
afterEach(()=>f.close());
it("uses DB topic messages/cursors and checks supplied parent ownership",()=>{
 const message=topics.addTopicMessage("r","t",{sender:"user",content:"hello",mentions:[]});
 topics.setTopicCursor("r","t","mem_one",message.id);
 expect(topics.getTopicCursors("r","t")).toEqual({mem_one:message.id});
 expect(topics.getTopicMessagesSince("r","t",message.id)).toEqual([]);
 expect(topics.getTopicMessagesSince("r","t","missing")).toEqual([message]);
 expect(topics.getLatestTopicMessageId("r","t")).toBe(message.id);
 expect(()=>topics.readAllTopicMessages("other","t")).toThrow("supplied room");
 expect(()=>topics.setTopicCursor("other","t","mem_one",null)).toThrow("supplied room");
 for(const name of ["messages.jsonl","cursors.json",".topic-seq"])expect(existsSync(join(topics.topicDir("r","t"),name))).toBe(false);
});
it("initializes invited-member cursor from indexed messages, not retired JSONL",()=>{
 importMessage(f.db,"r",{id:"persisted",ts:1,seq:9,sender:"user",content:"actual",mentions:[]});
 const directory=rooms.roomDir("r");mkdirSync(directory,{recursive:true});writeFileSync(join(directory,"messages.jsonl"),'{"id":"poison"}\n');
 expect(rooms.inviteGlobalMember("r",{id:"mem_one",name:"old-label",agentTemplate:"general"}).ok).toBe(true);
 expect(rooms.getCursors("r").mem_one).toBe("persisted");
});
it("preserves imported facts while bounding historical runtime-error views in every scope",()=>{
 const content='Member "Alice" request failed. Error: '+"x".repeat(4000);
 for(const scope of ["r","dm:mem_one","topic:t"])importMessage(f.db,scope,{id:"legacy",ts:1,sender:"system",content,mentions:[]});
 for(const messages of [readAllMessages("r"),readAllDmMessages("mem_one"),topics.readAllTopicMessages("r","t")])expect(Array.from(messages[0].content)).toHaveLength(300);
 for(const scope of ["r","dm:mem_one","topic:t"])expect(readMessages(scope)[0].content).toBe(content);
 const event={type:"message_end",errorMessage:"failure".repeat(1000)};
 importAgentEvent(f.db,{id:"error-event",scopeId:"r",ownerKey:"mem_one",memberId:"mem_one",seq:1,ts:1,event});
 expect((readAgentEvents<any>("r","mem_one")[0]).errorMessage).toBe(event.errorMessage);
 expect(Array.from((loadEventsFromDisk("r","mem_one")[0] as any).errorMessage)).toHaveLength(300);
 expect(Array.from((loadEventsPaginated("r","mem_one",10).events[0] as any).errorMessage)).toHaveLength(300);
});
