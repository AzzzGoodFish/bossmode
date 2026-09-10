import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";
import {MembersRepository} from "../../src/storage/repositories/members.js";
import {ConversationsRepository} from "../../src/storage/repositories/conversations.js";
import {DeliveryRepository} from "../../src/storage/repositories/delivery-repository.js";
import {postMessage} from "../../src/communication/message-bus.js";
import {initRouter} from "../../src/communication/router.js";
import {patchMessage,archiveMessagesInTransaction,readMessages} from "../../src/storage/message-repository.js";
let fixture:ReturnType<typeof coreFixture>;let members:MembersRepository;let rooms:ConversationsRepository;let captures:DeliveryRepository;
const transport=vi.hoisted(()=>({broadcast:vi.fn()}));
vi.mock("../../src/communication/ws.js",async original=>({...await original<object>(),broadcastToRoom:transport.broadcast}));
const stops:Array<()=>void>=[];
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
beforeEach(()=>{
  transport.broadcast.mockClear();
  fixture=coreFixture();members=new MembersRepository(fixture.db);rooms=new ConversationsRepository(fixture.db);captures=new DeliveryRepository(fixture.db);
  for(const [id,name] of [["mem_a","Alpha"],["mem_b","Beta"],["mem_c","Gamma"]]){
    members.insert({id,name,agentTemplate:"general",global:{},unifiedModel:true,unifiedExtensions:true,scopeOverrides:{},createdAt:1,updatedAt:1});rooms.ensureDmScope(id);
  }
  rooms.upsertRoom({id:"capture-room",name:"Captured",members:["Alpha","Beta"],globalMemberIds:["mem_a","mem_b"],createdAt:1});
});
afterEach(async()=>{await flush();for(const stop of stops.splice(0))stop();fixture.close();});

it("captures @all before rename/roster change, and never reads a patched or pruned message as delivery intent",async()=>{
  const mention=vi.fn();stops.push(initRouter({mention}));
  const message=postMessage("capture-room","user","@all original",["all"]);
  expect(message.mentionMemberIds).toEqual(["mem_a","mem_b"]);
  members.update({...members.get("mem_a")!,name:"Renamed"});members.update({...members.get("mem_c")!,name:"Alpha"});
  const room=rooms.getRoom("capture-room")!;room.globalMemberIds=["mem_b","mem_c"];rooms.upsertRoom(room);
  patchMessage("capture-room",message.id,{content:"Changed card",mentions:["Alpha"],mentionMemberIds:["mem_c"]});
  archiveMessagesInTransaction(fixture.db,"capture-room",0,10);expect(readMessages("capture-room")).toEqual([]);
  await flush();expect(mention.mock.calls.map(call=>call[1])).toEqual(["mem_a","mem_b"]);
  expect(mention.mock.calls[0][2].capture.snapshot.message.content).toBe("@all original");
  expect(captures.getCapture("capture-room",message.id)?.snapshot.targets.ordinary.map(actor=>actor.actorKey)).toEqual(["mem_a","mem_b"]);
});

it("explicit empty IDs and FYI remain empty even when textual mentions say @all",async()=>{
  const mention=vi.fn();stops.push(initRouter({mention}));
  const message=postMessage("capture-room","user","@all not dispatched",["all"],{mentionMemberIds:[],needResponse:[],needResponseMemberIds:[]});
  await flush();expect(mention).not.toHaveBeenCalled();
  expect(captures.getCapture("capture-room",message.id)?.snapshot).toMatchObject({targets:{ordinary:[],urgent:[],dm:[]},needResponse:[]});
});

it("splits urgent/ordinary targets once, excludes self and preserves the original reply context",async()=>{
  const mention=vi.fn(),urgent=vi.fn();stops.push(initRouter({mention,urgent}));
  postMessage("capture-room","Alpha","@Beta later !Gamma now !Alpha self",["Beta","Gamma","Alpha"],{senderMemberId:"mem_a",mentionMemberIds:["mem_b","mem_c","mem_a"],urgentMentions:["Gamma","Alpha"],urgentMentionMemberIds:["mem_c","mem_a"],needResponse:[],needResponseMemberIds:[]});
  await flush();expect(mention).toHaveBeenCalledTimes(1);expect(urgent).toHaveBeenCalledTimes(1);
  expect(mention.mock.calls[0][1]).toBe("mem_b");expect(urgent.mock.calls[0][1]).toBe("mem_c");
  expect(urgent.mock.calls[0][2]).toMatchObject({senderName:"Alpha",senderOrigin:"member",deliveryKind:"urgent",needResponse:[],needResponseMemberIds:[]});
});

it("DM user delivery goes through the same capture/router and own replies never reactivate the member",async()=>{
  const mention=vi.fn();stops.push(initRouter({mention}));
  const request=postMessage("dm:mem_a","user","Question");
  postMessage("dm:mem_a","Alpha","Reply",[],{senderMemberId:"mem_a"});
  await flush();expect(mention).toHaveBeenCalledTimes(1);
  expect(mention.mock.calls[0]).toMatchObject(["dm:mem_a","mem_a",{deliveryKind:"dm",capture:{messageId:request.id}}]);
});

it("an unresolved sender is retained as unresolved instead of acquiring the current matching name's identity",()=>{
  const message=postMessage("capture-room","Alpha","Unproven producer");
  expect(captures.getCapture("capture-room",message.id)?.snapshot).toMatchObject({origin:"unresolved",senderActorKey:null,senderMemberId:null});
});

it("capture failure rolls back message, sequence and outbox with no callback",async()=>{
  const mention=vi.fn();stops.push(initRouter({mention}));
  fixture.db.exec("CREATE TRIGGER capture_failure BEFORE INSERT ON delivery_captures BEGIN SELECT RAISE(ABORT,'capture-fault'); END");
  expect(()=>postMessage("capture-room","user","@Alpha",["Alpha"])).toThrow("capture-fault");
  await flush();expect(mention).not.toHaveBeenCalled();expect(readMessages("capture-room")).toEqual([]);
  expect(fixture.db.get("SELECT 1 FROM outbox")).toBeUndefined();expect(fixture.db.get("SELECT 1 FROM scope_sequences")).toBeUndefined();
});

it("fallback text uses the stable sender, parses exact mentions once, and treats plain names as literal text",async()=>{
  const {deliverMemberMessage}=await import("../../src/engine/tools.js");const mention=vi.fn();stops.push(initRouter({mention}));
  members.update({...members.get("mem_a")!,name:"mem_b"});members.update({...members.get("mem_c")!,name:"Alpha"});
  const room=rooms.getRoom("capture-room")!;room.globalMemberIds=["mem_a","mem_b","mem_c"];rooms.upsertRoom(room);
  deliverMemberMessage("capture-room","mem_a","@Beta @Alpha sync",{autoDelivered:true});
  deliverMemberMessage("capture-room","mem_a","Beta and Alpha are plain references");
  deliverMemberMessage("capture-room","mem_a","@mem_b self ping");
  await flush();expect(mention.mock.calls.map(call=>call[1])).toEqual(["mem_b","mem_c"]);
  const messages=readMessages("capture-room");expect(messages[0]).toMatchObject({sender:"mem_b",senderMemberId:"mem_a",mentions:["Beta","Alpha"],mentionMemberIds:["mem_b","mem_c"],autoDelivered:true});
  expect(messages[1].mentionMemberIds).toEqual([]);
  deliverMemberMessage("capture-room","mem_b","@mem_b back to you");await flush();expect(mention.mock.calls.at(-1)![1]).toBe("mem_a");
});

it("fallback DM replies preserve the UI payload and owner, and cannot post to another member's DM",async()=>{
  const {deliverMemberMessage}=await import("../../src/engine/tools.js");const mention=vi.fn();stops.push(initRouter({mention}));
  deliverMemberMessage("dm:mem_a","mem_a","hello dm");await flush();
  const [message]=readMessages("dm:mem_a");expect(message).toMatchObject({sender:"Alpha",senderMemberId:"mem_a",content:"hello dm",id:expect.any(String),ts:expect.any(Number)});
  expect(transport.broadcast).toHaveBeenCalledWith("dm:mem_a",{type:"room:message",roomId:"dm:mem_a",message});expect(mention).not.toHaveBeenCalled();
  expect(()=>deliverMemberMessage("dm:mem_b","mem_a","wrong owner")).toThrow("does not own");expect(readMessages("dm:mem_b")).toEqual([]);
});

it("a retained scope without an active room cannot recover routing targets from names",async()=>{
  const {deliverMemberMessage}=await import("../../src/engine/tools.js");const mention=vi.fn();stops.push(initRouter({mention}));
  fixture.db.run("INSERT INTO scopes VALUES('retained-room','room','retained-room',NULL)");
  deliverMemberMessage("retained-room","mem_a","@Beta");await flush();
  expect(readMessages("retained-room")[0].mentionMemberIds).toEqual([]);expect(mention).not.toHaveBeenCalled();
});

it("self urgent is silent and an optional normal callback can accept an urgent target",async()=>{
  const mention=vi.fn();stops.push(initRouter({mention}));
  postMessage("capture-room","Alpha","!Alpha",["Alpha"],{senderMemberId:"mem_a",mentionMemberIds:["mem_a"],urgentMentionMemberIds:["mem_a"]});
  await flush();expect(mention).not.toHaveBeenCalled();
  postMessage("capture-room","Beta","!Alpha",["Alpha"],{senderMemberId:"mem_b",mentionMemberIds:["mem_a"],urgentMentionMemberIds:["mem_a"]});
  await flush();expect(mention).toHaveBeenCalledTimes(1);expect(mention.mock.calls[0][2].deliveryKind).toBe("urgent");
});

it("message/debt settlement rolls back together and only the stable own-chat sender settles debt",async()=>{
  const {ReplyObligationRepository}=await import("../../src/storage/repositories/reply-obligation-repository.js");const replies=new ReplyObligationRepository(fixture.db);
  const request=postMessage("capture-room","user","@Alpha answer",["Alpha"]);
  expect(replies.listPending("capture-room","mem_a").map(row=>row.messageId)).toEqual([request.id]);
  members.update({...members.get("mem_a")!,name:"Renamed"});members.update({...members.get("mem_c")!,name:"Alpha"});
  postMessage("capture-room","Alpha","Different owner",[],{senderMemberId:"mem_c"});
  postMessage("capture-room","Renamed","Task activity",[],{senderMemberId:"mem_a",type:"task_event"});
  expect(replies.listPending("capture-room","mem_a")).toHaveLength(1);
  fixture.db.exec("CREATE TRIGGER settlement_failure BEFORE INSERT ON reply_settlements BEGIN SELECT RAISE(ABORT,'settlement-fault'); END");
  const before=readMessages("capture-room");expect(()=>postMessage("capture-room","Renamed","Failed reply",[],{senderMemberId:"mem_a"})).toThrow("settlement-fault");
  expect(readMessages("capture-room")).toEqual(before);expect(replies.listPending("capture-room","mem_a")).toHaveLength(1);
  fixture.db.exec("DROP TRIGGER settlement_failure");postMessage("capture-room","Renamed","Real reply",[],{senderMemberId:"mem_a"});
  expect(replies.listPending("capture-room","mem_a")).toEqual([]);
});

it("notification keys are scoped even when two scopes use the same local message ID",async()=>{
  const {enqueueScopeNotification,pendingScopeNotifications}=await import("../../src/storage/notification-repository.js");
  for(const scopeId of ["capture-room","dm:mem_a"])enqueueScopeNotification(scopeId,"shared-message",{type:"task:deleted",roomId:scopeId,taskId:"same-local-task"});
  expect(pendingScopeNotifications().map(row=>row.scopeId)).toEqual(["capture-room","dm:mem_a"]);
});

it("topic delivery keeps its own scope and its original parent-roster targets",async()=>{
  rooms.upsertTopic({id:"capture-topic",roomId:"capture-room",title:"Topic",anchorMessageId:"old-anchor",createdBy:"user",status:"active",createdAt:1,seedMode:"fresh",participants:[]});
  const mention=vi.fn();stops.push(initRouter({mention}));
  const request=postMessage("topic:capture-topic","user","@Alpha answer",["Alpha"]);
  members.update({...members.get("mem_a")!,name:"Renamed"});members.update({...members.get("mem_c")!,name:"Alpha"});
  await flush();expect(mention.mock.calls[0]).toMatchObject(["topic:capture-topic","mem_a",{capture:{messageId:request.id}}]);
  expect(fixture.db.get("SELECT 1 FROM reply_obligations WHERE scope_id='capture-room'")).toBeUndefined();
  expect(fixture.db.get("SELECT actor_key FROM reply_obligations WHERE scope_id='topic:capture-topic'")).toEqual({actor_key:"mem_a"});
});

it("one callback cannot mutate the captured routing plan for another recipient",async()=>{
  const calls:string[]=[];stops.push(initRouter({mention:(_scope,id,context)=>{
    calls.push(id);context.capture.snapshot.targets.ordinary.length=0;context.capture.snapshot.message.sender="poison";
  }}));
  const message=postMessage("capture-room","user","@all",["all"]);await flush();expect(calls).toEqual(["mem_a","mem_b"]);
  expect(captures.getCapture("capture-room",message.id)?.snapshot.message.sender).toBe("user");
});
