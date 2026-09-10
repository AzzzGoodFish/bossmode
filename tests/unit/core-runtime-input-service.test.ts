import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {MembersRepository} from "../../src/storage/repositories/members.js";
import {ConversationsRepository} from "../../src/storage/repositories/conversations.js";
import {DeliveryRepository} from "../../src/storage/repositories/delivery-repository.js";
import {InputQueueRepository} from "../../src/storage/repositories/input-queue-repository.js";
import {ReplyObligationRepository} from "../../src/storage/repositories/reply-obligation-repository.js";
import {ExecutionAttemptRepository} from "../../src/storage/repositories/execution-attempt-repository.js";
import {postMessage} from "../../src/communication/message-bus.js";
import {readMessages,writeMemberCursor,readMemberCursors} from "../../src/storage/message-repository.js";
import {acceptControlInput,acceptRuntimeInput,claimRuntimeInputs,finishRuntimeInputs,pendingRuntimeInputs,recoverRuntimeInputState} from "../../src/services/runtime-input-service.js";
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
