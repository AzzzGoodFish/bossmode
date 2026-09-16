import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {MembersRepository} from "../../src/data/repositories/members.js";
import {ConversationsRepository} from "../../src/data/repositories/conversations.js";
import {DeliveryRepository} from "../../src/data/repositories/delivery-repository.js";
import {InputQueueRepository} from "../../src/data/repositories/input-queue-repository.js";
import {ReplyObligationRepository} from "../../src/data/repositories/reply-obligation-repository.js";
import {ExecutionAttemptRepository} from "../../src/data/repositories/execution-attempt-repository.js";
import {postMessage} from "../../src/communication/message-bus.js";
import {readMessages,writeMemberCursor,readMemberCursors,importMessage} from "../../src/data/repositories/message-repository.js";
import {acceptControlInput,acceptRuntimeInput,claimRuntimeInputs,finishRuntimeInputs,pendingRuntimeInputs,recoverRuntimeInputState,runtimeInputPayload} from "../../src/services/runtime-input-service.js";
let f:ReturnType<typeof coreFixture>;
const owner={scopeId:"input-room",targetActorKey:"mem_input"};
beforeEach(()=>{
  f=coreFixture();const members=new MembersRepository(f.db),rooms=new ConversationsRepository(f.db);
  members.insert({id:"mem_input",name:"Input",agentTemplate:"general",global:{},unifiedModel:true,unifiedExtensions:true,scopeOverrides:{},createdAt:1,updatedAt:1});
  rooms.ensureDmScope("mem_input");rooms.upsertRoom({id:"input-room",name:"Inputs",members:["Input"],globalMemberIds:["mem_input"],createdAt:1});
});
afterEach(()=>f.close());
const control=(prompt:string,placement:"front"|"tail"="tail")=>acceptControlInput(owner.scopeId,owner.targetActorKey,{prompt,source:"system",trigger:"manual"},true,placement).input;
it("commits acceptance, cursor and immutable input together; duplicates do not re-prepare",()=>{
  const msg=postMessage(owner.scopeId,"user","@Input work",["Input"]),capture=new DeliveryRepository(f.db).getCapture(owner.scopeId,msg.id)!;
  const key={...owner,messageId:msg.id,deliveryKind:"ordinary" as const},prepare=vi.fn(()=>({prompt:"original",source:"room_mention" as const,trigger:"activate"}));
  expect(()=>acceptRuntimeInput(capture,key,prepare,{onAccepted:()=>{writeMemberCursor(owner.scopeId,owner.targetActorKey,msg.id);throw new Error("cursor failure");}})).toThrow("cursor failure");
  expect(pendingRuntimeInputs(owner)).toEqual([]);expect(readMemberCursors(owner.scopeId)[owner.targetActorKey]).toBeUndefined();
  const first=acceptRuntimeInput(capture,key,prepare,{onAccepted:()=>writeMemberCursor(owner.scopeId,owner.targetActorKey,msg.id)});
  const duplicate=acceptRuntimeInput(capture,key,()=>{throw new Error("must not re-prepare");},{placement:"front"});
  expect(first.accepted).toBe(true);expect(duplicate).toEqual({input:first.input,accepted:false});expect(readMemberCursors(owner.scopeId)[owner.targetActorKey]).toBe(msg.id);
});
it("persists front LIFO and tail FIFO ordering across reopen without inventing user chat",()=>{
  const a=control("tail one"),b=control("front one","front"),c=control("front two","front"),d=control("tail two");
  f.reopen();expect(pendingRuntimeInputs(owner).map(x=>x.id)).toEqual([c.id,b.id,a.id,d.id]);expect(readMessages(owner.scopeId)).toEqual([]);
  expect(()=>f.db.run("UPDATE queued_inputs SET placement='front' WHERE id=?",a.id)).toThrow();
});
it("claims an entire batch or none and rejects a stale settlement token",()=>{
  const a=control("first"),b=control("second"),queue=new InputQueueRepository(f.db);
  claimRuntimeInputs([b],"attempt-b","token-b");
  expect(()=>claimRuntimeInputs([a,b],"attempt-a","token-a")).toThrow("already dispatched");expect(queue.get(a)?.status).toBe("pending");
  claimRuntimeInputs([a],"attempt-a","token-a");
  expect(()=>finishRuntimeInputs([a,b],"token-a","completed","done")).toThrow("lost ownership");expect(queue.get(a)?.status).toBe("dispatched");
  finishRuntimeInputs([a],"token-a","failed","provider failure");
  expect(queue.get(a)).toMatchObject({status:"settled",outcome:"failed"});
  const debts=new ReplyObligationRepository(f.db).listPending(owner.scopeId,owner.targetActorKey);expect(debts.map(x=>x.messageId)).toEqual([b.messageId]);
});
it("restart retains pending work but never replays uncertain work or invents a reply",()=>{
  const a=control("pending"),b=control("dispatched"),attempts=new ExecutionAttemptRepository(f.db);
  f.db.transaction(()=>{attempts.prepare({id:"attempt",memberId:owner.targetActorKey,scopeId:owner.scopeId,operation:"input",externalReference:null,startedAt:1});attempts.markDispatched("attempt",owner.targetActorKey,2);claimRuntimeInputs([b],"attempt","token");});
  f.reopen();recoverRuntimeInputState();recoverRuntimeInputState();
  expect(pendingRuntimeInputs(owner).map(x=>x.id)).toEqual([a.id]);expect(new InputQueueRepository(f.db).get(b)?.status).toBe("uncertain");
  expect(new ExecutionAttemptRepository(f.db).get("attempt",owner.targetActorKey)?.status).toBe("interrupted");
  expect(new ReplyObligationRepository(f.db).listPending(owner.scopeId,owner.targetActorKey).map(x=>x.messageId)).toEqual([a.messageId]);
  expect(readMessages(owner.scopeId)).toEqual([]);
});
it("records broadcast busy-skip once without changing captured recipients or claiming a reply",()=>{
  const msg=postMessage(owner.scopeId,"user","@all broadcast",["all"]),capture=new DeliveryRepository(f.db).getCapture(owner.scopeId,msg.id)!;
  const key={...owner,messageId:msg.id,deliveryKind:"ordinary" as const};
  const receipt=acceptRuntimeInput(capture,key,()=>({prompt:"",source:"system",trigger:"broadcast"}),{skip:{diagnosis:"busy",disposition:"broadcast-skipped"}});
  expect(receipt.input.status).toBe("interrupted");expect(acceptRuntimeInput(capture,key,()=>{throw new Error("no retry");}).accepted).toBe(false);
  expect(new ReplyObligationRepository(f.db).listPending(owner.scopeId,owner.targetActorKey)).toEqual([]);
  expect(new DeliveryRepository(f.db).getCapture(owner.scopeId,msg.id)).toEqual(capture);expect(readMessages(owner.scopeId)).toHaveLength(1);
});
it("retired `!` legacy rows stay inert: old fields never surface and legacy urgent queue rows resume via owner keys",()=>{
  const json=(v:unknown)=>JSON.stringify(v);
  f.db.run("INSERT INTO messages(scope_id,id,seq,ts,sender,sender_member_id,origin,content,content_lower,type,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    owner.scopeId,"legacy-msg",1,1,"user",null,"user","!Input old ask","!input old ask",null,
    json({fields:{urgentMentions:["Input"],urgentMentionMemberIds:["mem_input"]},presentLists:["mentions","mentionMemberIds","urgentMentions","urgentMentionMemberIds"]}));
  for(const [kind,valueKind,value] of [["mention","label","Input"],["mention","id","mem_input"],["urgent","label","Input"],["urgent","id","mem_input"]] as const)
    f.db.run("INSERT INTO message_mentions VALUES(?,?,?,?,?,?)",owner.scopeId,"legacy-msg",kind,valueKind,0,value);
  const legacy=readMessages(owner.scopeId)[0]!;
  expect(legacy.mentions).toEqual(["Input"]);expect(legacy.mentionMemberIds).toEqual(["mem_input"]);
  expect("urgentMentions" in legacy).toBe(false);expect("urgentMentionMemberIds" in legacy).toBe(false);
  importMessage(f.db,owner.scopeId,{id:"legacy-import",ts:2,sender:"user",content:"!",mentions:[],urgentMentions:["Input"],urgentMentionMemberIds:["mem_input"]} as any);
  expect(String(f.db.get<{e:string}>("SELECT extra_json e FROM messages WHERE id='legacy-import'")!.e)).not.toContain("urgent");
  expect(readMessages(owner.scopeId).at(-1)).not.toHaveProperty("urgentMentions");

  f.db.run("INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES(?,?,?,?)",
    owner.scopeId,"legacy-msg",json({message:{id:"legacy-msg",content:"!Input old ask",mentions:["Input"]},context:null,origin:"user",messageType:"chat",senderActorKey:null,senderMemberId:null,targets:{ordinary:[],urgent:[{actorKey:"mem_input",memberId:"mem_input"}],dm:[]},needResponse:null}),1);
  f.db.run("INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,delivery_kind,target_member_id,accepted_at) VALUES(?,?,?,?,?,?)",
    owner.scopeId,"legacy-msg","mem_input","urgent","mem_input",1);
  f.db.run("INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,placement) VALUES(?,?,?,?,?,?,?,?,?)",
    owner.scopeId,"legacy-msg","mem_input","urgent",json({prompt:"legacy urgent prompt",source:"room_mention",trigger:"activate"}),"activate","pending",1,"tail");
  const queue=new InputQueueRepository(f.db);
  const pending=pendingRuntimeInputs(owner);expect(pending.map(x=>x.messageId)).toEqual(["legacy-msg"]);
  expect(runtimeInputPayload(pending[0]!).prompt).toBe("legacy urgent prompt");
  claimRuntimeInputs([pending[0]!],"attempt-legacy","token-legacy");
  finishRuntimeInputs([pending[0]!],"token-legacy","completed","done");
  expect(queue.get({id:pending[0]!.id,scopeId:owner.scopeId,targetActorKey:owner.targetActorKey})).toMatchObject({status:"settled",deliveryKind:"urgent"});
});
