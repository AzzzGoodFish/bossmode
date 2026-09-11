import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { coreFixture } from "./helpers/core-fixture.js";
import { join } from "node:path";
import { openDatabase, applyStorageMigrations, getDatabase, type Database } from "../src/storage/database.js";
import { baseStorageMigration } from "../src/storage/base-schema.js";
import { messagesMigration, eventSourceMigration } from "../src/storage/schema/messages.js";
import { archiveMessagesInTransaction, readArchivedMessages, importArchivedMessage, appendMessage, appendMessageInTransaction, importMessage, importMessageNextSequence, readMessages, pageMessages, messagesSince, patchMessage, searchMessageFacts, replaceMessages, writeMemberCursor, readMemberCursor } from "../src/storage/message-repository.js";
import { appendAgentEvent, importAgentEvent, readAgentEvents, pageActivity, readStats, memberTokenTotal, rebuildEventAggregates, pageAgentEvents } from "../src/storage/event-repository.js";
import { recordDailyUsage } from "../src/workspace/db/token-rollup.js";
import { getDmCursor, setDmCursor, addDmMessage } from "../src/workspace/dm-message-store.js";
import { postMessage, onMessage, scheduleMessageDispatch } from "../src/communication/message-bus.js";
import { handleAgentEvent, appendEventToDisk, loadEventsFromDisk, scheduleAgentEventDispatch } from "../src/engine/event-handler.js";
import type { RoomMessage } from "../src/shared/types.js";

const transport = vi.hoisted(() => ({room:vi.fn(),agent:vi.fn()}));
vi.mock("../src/communication/ws.js",() => ({broadcastToRoom:transport.room,broadcastToAgentSubscribers:transport.agent}));
vi.mock("../src/engine/agent-manager.js",() => ({refreshContextUsage:vi.fn()}));
vi.mock("../src/engine/knowledge-activity.js",() => ({maybeEmitKnowledgeActivity:vi.fn()}));
vi.mock("../src/workspace/room-store.js",() => ({getRoom:vi.fn()}));
vi.mock("../src/foundation/logger.js",() => ({logger:{info:vi.fn(),error:vi.fn()}}));

let db: Database; let root: string; let fixture: ReturnType<typeof coreFixture>;
const member = {ownerKey:"mem_old",memberId:"mem_old"};
const input = {sender:"old-name",senderMemberId:"mem_old",content:"hello",mentions:["target"],mentionMemberIds:["mem_target"]};
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
beforeEach(() => {
  fixture = coreFixture(); root = fixture.root; db = fixture.db;
  db.run("INSERT INTO scopes VALUES('room','room','room',NULL),('dm:mem_old','dm',NULL,'mem_old'),('topic:t','topic','room',NULL)");
  vi.clearAllMocks();
});
afterEach(async () => { await flush(); fixture.close(); });

describe("authoritative message transactions",() => {
  it("commits message, sequence, all literal target IDs, reply and intent atomically in every scope",() => {
    for (const scope of ["room","dm:mem_old","topic:t"]) {
      const msg = appendMessage(scope,{...input,urgentMentions:["target"],urgentMentionMemberIds:["mem_target"],needResponse:["target"],needResponseMemberIds:["mem_target"],replyTo:{messageId:"historic",seq:9}});
      expect(msg.seq).toBe(1); expect(readMessages(scope)).toEqual([msg]);
      expect(db.get<{n:number}>("SELECT COUNT(*) n FROM message_mentions WHERE scope_id=?",scope)!.n).toBe(6);
      expect(db.get<{next_seq:number}>("SELECT next_seq FROM scope_sequences WHERE scope_id=?",scope)!.next_seq).toBe(2);
    }
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM outbox")!.n).toBe(3);
    expect(readdirSync(root).every(name => name === "knowledge" || name.startsWith("bossmode.db"))).toBe(true);
  });
  it("dispatches the committed original snapshot even when history is archived before delivery",async () => {
    const off = onMessage(vi.fn()); const message = postMessage("room","user","original");
    patchMessage("room",message.id,{content:"changed"}); archiveMessagesInTransaction(db,"room",0,9000);
    await flush(); expect(transport.room).toHaveBeenCalledWith("room",expect.objectContaining({message})); off();
  });
  it("rolls nested task composition back without broadcasting or consuming a seq",async () => {
    const listener = vi.fn(); const off = onMessage(listener);
    expect(() => db.transaction(tx => { appendMessageInTransaction(tx,"room",input); postMessage("room","system","task event"); throw Error("task failed"); })).toThrow("task failed");
    await flush();
    expect(readMessages("room")).toEqual([]); expect(transport.room).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM outbox")!.n).toBe(0);
    expect(appendMessage("room",input).seq).toBe(1); off();
  });
  it("rolls outbox failures back, rejects unknown scopes, and never falls back to files",() => {
    db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'outbox full'); END");
    expect(() => appendMessage("room",input)).toThrow("outbox full"); expect(readMessages("room")).toEqual([]);
    expect(db.get("SELECT 1 FROM scope_sequences")).toBeUndefined();
    db.exec("DROP TRIGGER fail_outbox"); expect(() => appendMessage("unknown",input)).toThrow();
    db.close(); expect(() => appendMessage("room",input)).toThrow("not initialized");
  });
  it("defers until outer commit and recovers persisted undelivered intents after reopen",async () => {
    const listener = vi.fn(); const off = onMessage(listener);
    db.transaction(() => { postMessage("room","user","committed"); expect(transport.room).not.toHaveBeenCalled(); });
    await flush(); expect(listener).toHaveBeenCalledTimes(1);
    const pending = appendMessage("room",input); db = fixture.reopen();
    scheduleMessageDispatch(); await flush();
    expect(listener).toHaveBeenLastCalledWith("room",pending);
    scheduleMessageDispatch(); await flush(); expect(listener).toHaveBeenCalledTimes(2); off();
  });
  it("leaves failed listener deliveries pending for parent idempotent recovery",async () => {
    const off = onMessage(() => { throw Error("routing unavailable"); }); postMessage("room","user","retry"); await flush();
    expect(db.get<{delivered_at:number | null;attempts:number}>("SELECT delivered_at,attempts FROM outbox")).toEqual({delivered_at:null,attempts:1});
    off(); scheduleMessageDispatch(); await flush(); expect(db.get<{attempts:number}>("SELECT attempts FROM outbox")!.attempts).toBe(2);
  });
  it("does not reinterpret captured mention IDs or historical sender labels",async () => {
    // Simulate a prepared attachment boundary: target IDs already captured, then label changes.
    const targets = {mentions:["target"],mentionMemberIds:["mem_target"]}; await Promise.resolve();
    const msg = postMessage("room","renamed-now","literal @target",targets.mentions,{senderMemberId:"mem_old",mentionMemberIds:targets.mentionMemberIds});
    expect(msg.sender).toBe("renamed-now"); expect(msg.mentionMemberIds).toEqual(["mem_target"]);
    importMessage(db,"room",{id:"foreign",ts:1,sender:"renamed-now",content:"historical unresolved",mentions:["target"]});
    expect(readMessages("room")[1].senderMemberId).toBeUndefined();
    expect(db.get<{origin:string}>("SELECT origin FROM messages WHERE id='foreign'")!.origin).toBe("unresolved");
  });
});

describe("history, search and cursors",() => {
  it("retires obsolete response booleans without changing room, DM and topic message bodies",() => {
    for (const scope of ["room","dm:mem_old","topic:t"]) {
      for (const [i,flag] of [true,false].entries()) {
        const raw = {id:`boolean-${i}`,seq:i+1,ts:123,sender:"literal old name",content:"literal 历史",mentions:["unresolved"],mentionMemberIds:[],needResponse:flag,needResponseMemberIds:[]} as unknown as RoomMessage;
        const expected = {...raw}; delete expected.needResponse;
        importMessage(db,scope,raw);
        expect(readMessages(scope)[i]).toEqual(expected);
        expect(pageMessages(scope)).toContainEqual(expected);
        expect(searchMessageFacts(scope,{query:"历史"}).messages).toContainEqual(expected);
        expect(patchMessage(scope,raw.id,{content:"edited"})).toEqual({...expected,content:"edited"});
        importArchivedMessage(db,scope,900,i,raw);
        expect(readArchivedMessages(scope,900)[i]).toEqual(expected);
        expect((raw as any).needResponse).toBe(flag);
      }
      expect(db.get<{n:number}>("SELECT COUNT(*) n FROM message_mentions WHERE scope_id=? AND kind='response'",scope)!.n).toBe(0);
      archiveMessagesInTransaction(db,scope,0,1000);
      expect(readArchivedMessages(scope,1000).map(m=>m.needResponse)).toEqual([undefined,undefined]);
    }
    db=fixture.reopen();
    expect(readArchivedMessages("room",900).map(m=>m.needResponse)).toEqual([undefined,undefined]);
    for(const table of ["outbox","reply_obligations","queued_inputs","execution_attempts"]) expect(db.get<{n:number}>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
  });
  it("keeps response absence and explicit lists distinct and rejects malformed current input",() => {
    const base = {id:"source",ts:1,sender:"user",content:"inert",mentions:[]};
    for(const [i,value] of [undefined,[],["literal"]].entries()) {
      const raw={...base,id:`list-${i}`,...(value===undefined?{}:{needResponse:value})};
      importMessage(db,"room",raw);expect(readMessages("room")[i]).toEqual(raw);
    }
    expect(() => appendMessage("room",{...input,needResponse:true} as any)).toThrow("Invalid needResponse");
    const normalized={...base,id:"normalized",needResponseMemberIds:["mem_gone","mem_gone"]};
    importMessage(db,"room",normalized);expect(readMessages("room").at(-1)).toEqual(normalized);
    replaceMessages("room",readMessages("room"));expect(readMessages("room").at(-1)).toEqual(normalized);
    for(const value of [null,1,"literal",{}]) expect(() => importMessage(db,"room",{...base,needResponse:value} as any)).toThrow("Invalid needResponse");
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM outbox")!.n).toBe(0);
  });
  it("strictly preserves raw metadata, missing seq, snapshots and full unbounded historical content",() => {
    const raw: RoomMessage = {id:"raw-id",ts:123,sender:"old",content:"数据".repeat(200000),mentions:[],needResponse:[],urgentMentionMemberIds:[],replyTo:{messageId:"gone",seq:27},attachments:[{id:"a",originalName:"old.txt",storedName:"a.txt",mimeType:"text/plain",size:3} as any]};
    importMessage(db,"room",raw); expect(readMessages("room")).toEqual([raw]);
    expect(() => importMessage(db,"room",raw)).toThrow();
    importMessageNextSequence(db,"room",80); expect(appendMessage("room",input).seq).toBe(80);
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM outbox")!.n).toBe(1);
  });
  it("preserves chronology, unknown/first before, fromSeq tail and Unicode substring semantics",() => {
    const all: RoomMessage[] = Array.from({length:7},(_,i) => ({id:`m${i}`,seq:i+1,ts:i === 1 ? 1 : 10+i,sender:i%2 ? "old" : "user",content:`Ä中文 %_${i}`,mentions:[]}));
    for (const msg of all) importMessage(db,"room",msg);
    expect(pageMessages("room",{before:"m0",limit:2})).toEqual(all.slice(-2));
    expect(pageMessages("room",{before:"missing",limit:2})).toEqual(all.slice(-2));
    expect(pageMessages("room",{before:"m4"})).toEqual(all.slice(0,4));
    expect(pageMessages("room",{fromSeq:2,limit:2})).toEqual(all.slice(-2));
    expect(pageMessages("room",{around:"m3",limit:3})).toEqual(all.slice(2,5));
    expect(messagesSince("room","missing")).toEqual(all);
    expect(searchMessageFacts("room",{query:"ä中文 %_",from:"old",limit:500}).messages.map(m => m.id)).toEqual(["m5","m3","m1"]);
    expect(searchMessageFacts("room",{aroundSeq:4,query:"ignored",limit:3})).toEqual({total:1,messages:all.slice(2,5)});
    expect(searchMessageFacts("room",{after:12,before:15}).messages).toEqual(all.slice(2,5).reverse());
  });
  it("patches message content without changing identity/order and never rewinds sequence",() => {
    const a = appendMessage("room",input); const b = appendMessage("room",input);
    expect(patchMessage("room",a.id,{content:"closed",id:"illegal",seq:500,ts:0})).toEqual({...a,content:"closed"});
    expect(readMessages("room").map(m => m.id)).toEqual([a.id,b.id]);
    replaceMessages("room",[b]); expect(appendMessage("room",input).seq).toBe(3);
  });
  it("archives snapshots inside a parent transaction without files, preserving raw historical archive imports",() => {
    const first = appendMessage("room",input); const second = appendMessage("room",input);
    expect(() => db.transaction(tx => { archiveMessagesInTransaction(tx,"room",1,1000); throw Error("summary failed"); })).toThrow("summary failed");
    expect(readArchivedMessages("room",1000)).toEqual([]); expect(readMessages("room")).toHaveLength(2);
    expect(archiveMessagesInTransaction(db,"room",1,1000)).toEqual({archived:[first],kept:[second],timestamp:1000});
    expect(readArchivedMessages("room",1000)).toEqual([first]); expect(readMessages("room")).toEqual([second]);
    importArchivedMessage(db,"room",900,0,{...first,content:"older historical snapshot"});
    expect(readArchivedMessages("room",900)[0].content).toBe("older historical snapshot");
    expect(appendMessage("room",input).seq).toBe(3);
  });
  it("uses only member cursor slots for DM, room and topic",() => {
    const m = addDmMessage("mem_old",input); setDmCursor("mem_old",{messageId:m.id,seq:m.seq!});
    expect(getDmCursor("mem_old")).toEqual({messageId:m.id,seq:1});
    setDmCursor("mem_old",{messageId:"historical-gone",seq:90});
    expect(getDmCursor("mem_old")).toEqual({messageId:"historical-gone",seq:90});
    setDmCursor("mem_old",{messageId:null,seq:90});
    expect(getDmCursor("mem_old")).toEqual({messageId:null,seq:90});
    for (const scope of ["room","topic:t"]) { writeMemberCursor(scope,"mem_old","raw-id"); expect(readMemberCursor(scope,"mem_old")).toBe("raw-id"); }
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM read_cursors WHERE kind='user'")!.n).toBe(0);
  });
});

describe("complete event authority and aggregate identity",() => {
  it("persists multi-megabyte complete events with keyset activity pages and ordinal history",() => {
    appendAgentEvent("room",member,{type:"agent_start",ts:1},"e1");
    appendAgentEvent("room",member,{type:"message_start",ts:2},"e2");
    const event = {type:"message_end",ts:3,text:"full".repeat(800000),thinking:"reason",usage:{inputTokens:10,outputTokens:7},model:"p/m"};
    appendAgentEvent("room",member,event,"e3");
    const page = pageActivity("room","mem_old",{limit:1});
    expect(page).toEqual({events:[event],hasMore:true,nextBeforeSeq:3,indexed:true});
    expect(pageActivity("room","mem_old",{beforeSeq:3,limit:10}).events).toEqual([{type:"agent_start",ts:1}]);
    expect(pageAgentEvents("room","mem_old",1,2)).toEqual({events:[{type:"message_start",ts:2}],total:3,hasMore:true});
  });
  it("replaces only C's obsolete projection tables on staging, never members or unrelated tables",() => {
    const staged = openDatabase(join(root,"stage.sqlite"));
    staged.exec("CREATE TABLE members(id TEXT); INSERT INTO members VALUES('historical-member'); CREATE TABLE activity_events(byte_offset INTEGER); CREATE TABLE token_usage_daily(old TEXT); CREATE TABLE unrelated(id TEXT); INSERT INTO unrelated VALUES('kept');");
    applyStorageMigrations(staged,[baseStorageMigration,messagesMigration,eventSourceMigration]);
    expect(staged.get<{id:string}>("SELECT id FROM members")!.id).toBe("historical-member");
    expect(staged.get("SELECT 1 FROM unrelated")).toBeDefined(); staged.close();
  });
  it("does not invent active time for imported events without original timestamps",() => {
    importAgentEvent(db,{id:"a",scopeId:"room",...member,seq:1,ts:0,event:{type:"agent_start"}});
    importAgentEvent(db,{id:"b",scopeId:"room",...member,seq:2,ts:100,event:{type:"agent_end",ts:100}});
    expect(readStats("room","mem_old").activeMs).toBe(0); rebuildEventAggregates();
    expect(readStats("room","mem_old").activeMs).toBe(0);
  });
  it("deduplicates event identities, token deltas and complete rebuilds, including reopened contexts",() => {
    appendAgentEvent("room",member,{type:"agent_start",ts:100},"start");
    appendAgentEvent("room",member,{type:"tool_start",ts:120},"tool");
    const event = {type:"message_end",ts:150,usage:{inputTokens:10,outputTokens:2,cacheRead:3,cacheWrite:4,cost:0.1},model:"p/m"};
    appendAgentEvent("room",member,event,"end-message");
    appendAgentEvent("room",member,{type:"agent_end",ts:200},"end");
    db = fixture.reopen();
    appendAgentEvent("room",member,event,"end-message"); recordDailyUsage("end-message");
    expect(() => appendAgentEvent("room",member,{...event,ts:151},"end-message")).toThrow("Conflicting event identity");
    const stats = readStats("room","mem_old");
    expect(stats).toEqual({turns:1,toolCalls:1,activeMs:100,tokens:{input:10,output:2,cacheRead:3,cacheWrite:4},cost:0.1,updatedAt:200});
    expect(memberTokenTotal("mem_old")).toBe(19);
    db.exec("CREATE TABLE untouched(id TEXT); INSERT INTO untouched VALUES('member-row');");
    rebuildEventAggregates(); rebuildEventAggregates(); expect(readStats("room","mem_old")).toEqual(stats);
    expect(db.get<{turns:number}>("SELECT turns FROM token_usage_daily")!.turns).toBe(1);
    expect(db.get("SELECT 1 FROM untouched")).toBeDefined();
  });
  it("rolls event/rollup/stats back when durable notification fails",() => {
    db.exec("CREATE TRIGGER fail_event_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'full'); END");
    expect(() => appendAgentEvent("room",member,{type:"message_end",usage:{inputTokens:9}},"failed")).toThrow("full");
    for (const table of ["agent_events","member_statistics","token_usage_daily","event_usage_receipts"]) expect(db.get<{n:number}>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
  });
  it("imports full payloads, absent timestamps and unresolved historical identities without rebinding reused names",() => {
    const fact = {id:"source:line:9",scopeId:"topic:t",ownerKey:"legacy-source:old-name",memberId:null,seq:9,ts:0,event:{type:"message_end",text:"x".repeat(500000),usage:{inputTokens:30},custom:{preserved:true}}};
    expect(importAgentEvent(db,fact)).toBe(true); expect(importAgentEvent(db,fact)).toBe(false);
    expect(readAgentEvents("topic:t",fact.ownerKey)).toEqual([fact.event]); expect(memberTokenTotal("mem_old")).toBe(0);
    expect(db.get<{n:number}>("SELECT COUNT(*) n FROM outbox")!.n).toBe(0);
    appendAgentEvent("dm:mem_old",member,{type:"message_end",usage:{inputTokens:4}},"dm-event");
    expect(memberTokenTotal("mem_old")).toBe(4);
  });
  it("keeps streams realtime-only, enriches final content, preserves origins, and delays final broadcast until commit",async () => {
    const buffer: any[] = [];
    handleAgentEvent("room","latest-label","i",{type:"message_update",text:"hello"},buffer,"mem_old");
    expect(transport.agent).toHaveBeenCalledTimes(1); expect(readAgentEvents("room","mem_old")).toEqual([]);
    db.transaction(() => {
      handleAgentEvent("room","latest-label","i",{type:"message_end",usage:{inputTokens:2}},buffer,"mem_old","p/m","runtime-event-1");
      expect(transport.agent).toHaveBeenCalledTimes(1);
    });
    await flush(); expect(buffer[0]).toMatchObject({type:"message_end",text:"hello",model:"p/m"});
    expect(loadEventsFromDisk("room","mem_old")).toEqual(buffer);
    expect(transport.agent).toHaveBeenLastCalledWith("room","latest-label",expect.objectContaining({memberId:"mem_old",event:buffer[0]}));
    appendEventToDisk("room","mem_old",{type:"user_prompt",text:"user",trigger:"manual",ts:50},"user-event");
    scheduleAgentEventDispatch(); await flush(); expect(readAgentEvents("room","mem_old")).toHaveLength(2);
  });
  it("retains current live runtime-error limits but does not truncate strict historical imports",async () => {
    const full = `Member "name" error: ${"错误".repeat(400)}`;
    expect(Array.from(appendMessage("room",{sender:"system",content:full,mentions:[]}).content)).toHaveLength(300);
    importMessage(db,"room",{id:"raw-error",sender:"system",content:full,mentions:[],ts:1,seq:10});
    expect(readMessages("room")[1].content).toBe(full);
    appendEventToDisk("room","mem_old",{type:"message_end",errorMessage:"错".repeat(1000),text:"full successful content"} as any,"limited-error");
    await flush();
    expect((readAgentEvents<any>("room","mem_old")[0]).errorMessage).toHaveLength(300);
    expect((readAgentEvents<any>("room","mem_old")[0]).text).toBe("full successful content");
  });
  it("does not broadcast or buffer a final event whose commit failed",async () => {
    const buffer: any[] = []; db.exec("PRAGMA query_only=ON");
    expect(() => handleAgentEvent("room","name","i2",{type:"message_end"},buffer,"mem_old")).toThrow(); await flush();
    expect(buffer).toEqual([]); expect(transport.agent).not.toHaveBeenCalled(); db.exec("PRAGMA query_only=OFF");
  });
});
