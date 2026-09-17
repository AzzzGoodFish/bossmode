import { canonicalJson, type JsonValue } from "../kernel/json.js";
import {randomUUID} from "node:crypto";
import {getDatabase, type Database} from "../data/database.js";
import { instanceKey, instances, memberRuntimeAllowed, runtimeIsStopping, trackMemberOperation, transition, updateDispatchState, chatTargetOf, type AgentInstance } from "./instance.js";
import { logger } from "../kernel/logger.js";
import type { AgentHistoryEvent } from "./events.js";
import type { AgentMemberConfig } from "./types.js";
import { formatRuntimeErrorMessage, isMemberConfigured, memberUnconfiguredMessage } from "./instance.js";
import { DeliveryRepository, deliveryKeyParams, deliveryText, deliveryTime, type CapturedMessage, type DeliveryKey } from "../data/repositories/delivery-repository.js";
import {ReplyObligationRepository,type ReplyDisposition} from "../data/repositories/reply-obligation-repository.js";
import {executionScopeId,assertExecutionOwner} from "../data/repositories/execution-identity.js";

export interface PreparedRuntimeInput {
  prompt:string;
  source:"room_mention"|"private_instruction"|"system";
  trigger:string;
  replySources?:string[];
}
export interface RuntimeInputOwner {scopeId:string;targetActorKey:string}
export const runtimeInputOwner=(scope:string,memberId:string):RuntimeInputOwner=>({scopeId:executionScopeId(scope),targetActorKey:memberId});

/** Preparation runs once, outside SQL; acceptance, payload and optional cursor commit together.
 * A duplicate never re-reads history or re-applies interruption policy. */
export function acceptRuntimeInput(
  capture:CapturedMessage,key:DeliveryKey,prepare:()=>PreparedRuntimeInput,
  options:{placement?:"front"|"tail";onAccepted?:()=>void;skip?:{diagnosis:string;disposition:ReplyDisposition}}={},
):{input:QueuedInput;accepted:boolean}{
  const db=getDatabase();db.assertOutsideTransaction();
  const queue=new InputQueueRepository(db),deliveries=new DeliveryRepository(db);
  const old=queue.getByDelivery(key);
  if(key.scopeId!==capture.scopeId||key.messageId!==capture.messageId)throw new Error("Runtime input capture identity mismatch");
  if(old){deliveries.captureMessage(capture,Date.now());return {input:old,accepted:false};}
  const payload=prepare();
  if(!payload.prompt.trim()&&!options.skip)throw new Error("Runtime input requires a prompt");
  return db.transaction(()=>{
    const at=Date.now();
    deliveries.captureMessage(capture,at);
    new ReplyObligationRepository(db).openForCapturedMessage(capture,at);
    deliveries.acceptCapturedDelivery({...key,snapshot:capture.snapshot},at);
    const {input}=queue.enqueue({...key,payload:payload as unknown as JsonValue,trigger:payload.trigger,placement:options.placement},at);
    options.onAccepted?.();
    if(options.skip){
      queue.interrupt(input,{status:"pending"},options.skip.diagnosis,at);
      new ReplyObligationRepository(db).dismissPending(key.scopeId,key.targetActorKey,options.skip.disposition,options.skip.diagnosis,at,[key.messageId]);
    }
    return {input:queue.get(input)!,accepted:true};
  });
}

/** A control has its own non-visible system identity, never an invented human timeline row. */
export function acceptControlInput(scopeValue:string,memberId:string,payload:PreparedRuntimeInput,replyExpected:boolean,placement:"front"|"tail"="tail",onAccepted?:()=>void):{input:QueuedInput;accepted:boolean}{
  const db=getDatabase(),scopeId=assertExecutionOwner(db,memberId,scopeValue),messageId=`control:${randomUUID()}`;
  const actor={actorKey:memberId,memberId};
  const deliveryKind=scopeId.startsWith("dm:")?"dm":"ordinary";
  const capture:CapturedMessage={scopeId,messageId,snapshot:{
    message:{id:messageId,sender:"system",content:payload.prompt,mentions:[]},
    context:{control:true,trigger:payload.trigger},origin:"system",messageType:"chat",senderActorKey:null,senderMemberId:null,
    targets:{ordinary:deliveryKind==="ordinary"?[actor]:[],dm:deliveryKind==="dm"?[actor]:[]},
    needResponse:replyExpected?[actor]:[],
  }};
  return db.transaction(()=>{
    const at=Date.now(),key={scopeId,messageId,targetActorKey:memberId,deliveryKind} as DeliveryKey;
    const deliveries=new DeliveryRepository(db);deliveries.captureMessage(capture,at);
    new ReplyObligationRepository(db).openForCapturedMessage(capture,at);
    deliveries.acceptCapturedDelivery({...key,snapshot:capture.snapshot},at);
    const result=new InputQueueRepository(db).enqueue({...key,payload:payload as unknown as JsonValue,trigger:payload.trigger,placement},at);
    onAccepted?.();return {input:result.input,accepted:result.enqueued};
  });
}

export function pendingRuntimeInputs(owner:RuntimeInputOwner):QueuedInput[]{return new InputQueueRepository(getDatabase()).listReady(owner);}
export function pendingRuntimeInputCount(owner:RuntimeInputOwner):number{return new InputQueueRepository(getDatabase()).countPending(owner);}
/** ① B1: member-level queue views — one runtime serves every chat. */
export function pendingRuntimeInputOwners(memberId:string):string[]{return new InputQueueRepository(getDatabase()).listReadyOwners(memberId);}
export function memberPendingInputCount(memberId:string):number{return new InputQueueRepository(getDatabase()).countPendingForMember(memberId);}
export function runtimeInputPayload(input:QueuedInput):PreparedRuntimeInput{
  const value=input.payload as unknown as PreparedRuntimeInput;
  if(!value||typeof value.prompt!=="string"||typeof value.trigger!=="string"||!["room_mention","private_instruction","system"].includes(value.source))throw new Error(`Invalid durable runtime input: ${input.id}`);
  return value;
}
export function runtimeReplySources(inputs:readonly QueuedInput[]):string[]{
  return [...new Set(inputs.flatMap(input=>[input.messageId,...(runtimeInputPayload(input).replySources??[])]))];
}
/** A public activation waits for its own explicit continuations, not unrelated future inputs. */
export function runtimeInputHasContinuation(input:QueuedInput):boolean{
  return !!getDatabase().get(`SELECT 1 FROM queued_inputs q JOIN json_each(q.payload_json,'$.replySources') s
    WHERE q.scope_id=? AND q.target_actor_key=? AND q.status IN ('pending','dispatched') AND s.value=? LIMIT 1`,input.scopeId,input.targetActorKey,input.messageId);
}
export function hasRuntimeReply(owner:RuntimeInputOwner,inputs:readonly QueuedInput[]):boolean{
  const ids=new Set(runtimeReplySources(inputs));
  return new ReplyObligationRepository(getDatabase()).listPending(owner.scopeId,owner.targetActorKey).some(debt=>ids.has(debt.messageId));
}
/** Called within the actual SDK attempt's dispatch transaction; rolls back the WHOLE batch on conflict. */
export function claimRuntimeInputs(inputs:readonly QueuedInput[],attemptId:string,dispatchToken:string):void{
  const db=getDatabase();db.transaction(()=>{
    const queue=new InputQueueRepository(db);
    for(const input of inputs)if(!queue.beginDispatch(input,{token:dispatchToken,executionAttemptId:attemptId},Date.now()))throw new Error(`Runtime input already dispatched: ${input.id}`);
  });
}
export function finishRuntimeInputs(inputs:readonly QueuedInput[],dispatchToken:string,outcome:"completed"|"failed"|"cancelled",diagnosis:string):void{
  const db=getDatabase();db.transaction(()=>{
    const queue=new InputQueueRepository(db),replies=new ReplyObligationRepository(db),at=Date.now();
    for(const input of inputs){
      const current=queue.get(input);
      if(current?.status==="pending")queue.interrupt(input,{status:"pending"},diagnosis,at);
      else if(current?.status==="dispatched"&&!queue.settle(input,dispatchToken,{outcome,result:null},at))throw new Error(`Runtime input settlement lost ownership: ${input.id}`);
      if(outcome!=="completed")replies.dismissPending(input.scopeId,input.targetActorKey,outcome,diagnosis,at,runtimeReplySources([input]));
    }
  });
}
export function dismissRuntimeReplies(inputs:readonly QueuedInput[],disposition:ReplyDisposition,diagnosis:string):void{
  const db=getDatabase();db.transaction(()=>{
    const replies=new ReplyObligationRepository(db);
    for(const input of inputs)replies.dismissPending(input.scopeId,input.targetActorKey,disposition,diagnosis,Date.now(),runtimeReplySources([input]));
  });
}
export function cancelPendingRuntimeInputs(owner:RuntimeInputOwner,diagnosis:string,disposition:"cancelled"|"failed"="cancelled"):void{
  const db=getDatabase();db.transaction(()=>{
    const queue=new InputQueueRepository(db),replies=new ReplyObligationRepository(db);
    for(;;){
      const pending=queue.listReady(owner);if(!pending.length)break;
      for(const input of pending){queue.interrupt(input,{status:"pending"},diagnosis,Date.now());replies.dismissPending(input.scopeId,input.targetActorKey,disposition,diagnosis,Date.now(),runtimeReplySources([input]));}
    }
  });
}

/** Startup only, before runtime admission opens. No history reconstructs a live request. */
export function recoverRuntimeInputState():void{
  const db=getDatabase();db.transaction(()=>{
    const at=Date.now();new InputQueueRepository(db).recoverStartup(at);
    new ExecutionAttemptRepository(db).interruptIncomplete(at);
    const replies=new ReplyObligationRepository(db);
    for(const row of db.all<{id:number;scope:string;actor:string}>("SELECT id,scope_id scope,target_actor_key actor FROM queued_inputs WHERE status='uncertain'")){
      const input=new InputQueueRepository(db).get({id:row.id,scopeId:row.scope,targetActorKey:row.actor})!;
      replies.dismissPending(row.scope,row.actor,"failed","execution outcome uncertain after restart",at,runtimeReplySources([input]));
    }
  });
}

// -- One pump per member; waiters observe durable settlement receipts --

export function queueDepth(instance:AgentInstance):number{return memberPendingInputCount(instance.memberId);}
const inputPumps=new Map<string,Promise<void>>();
// Waiter handles observe committed receipts; they are not queue or reply authority.
const inputProgress=new Map<string,Set<(error?:unknown)=>void>>();
export function waitForInputSettlement(input:QueuedInput,operation:Promise<void>):Promise<void>{
  const key=instanceKey(input.targetActorKey);
  return new Promise((resolve,reject)=>{
    const listeners=inputProgress.get(key)??new Set<(error?:unknown)=>void>();inputProgress.set(key,listeners);
    let finished=false;
    const cleanup=()=>{finished=true;listeners.delete(check);if(!listeners.size&&inputProgress.get(key)===listeners)inputProgress.delete(key);};
    const check=(error?:unknown)=>{if(finished)return;try{if(error)throw error;if(!memberRuntimeAllowed(input.targetActorKey)){cleanup();resolve();return;}const row=new InputQueueRepository(getDatabase()).get(input);if(row&&row.status!=="pending"&&row.status!=="dispatched"&&!runtimeInputHasContinuation(input)){cleanup();resolve();}}catch(error){cleanup();reject(error);}};
    listeners.add(check);
    void operation.then(()=>check(),error=>check(error));
  });
}
const inputScopeEpoch=new Map<string,number>();
export function invalidateInputScope(key:string):void{inputScopeEpoch.set(key,(inputScopeEpoch.get(key)??0)+1);}
/** Wake settlement waiters for a member (success or failure). */
function notifyInputProgress(key:string,error?:unknown):void{
  for(const notify of [...(inputProgress.get(key)??[])])notify(error);
}


/** Runtime collaborators; scheduling, receipts and continuation policy stay here. */
export interface SchedulerServices {
  buildSession(memberId: string, scopeId: string): Promise<AgentInstance | null>;
  memberConfig(memberId: string): AgentMemberConfig | null;
  canExecuteScope(scopeId: string, memberId: string): boolean;
  postSystemNotice(scopeId: string, text: string): void;
  emitEvent(scopeId: string, memberId: string, event: AgentHistoryEvent): void;
  refreshProfileSources(instance: AgentInstance): void;
  applyPendingControls(instance: AgentInstance, trigger: string): void;
  flushPendingReload(instance: AgentInstance): void;
}
let services: SchedulerServices | undefined;
export function configureScheduler(next: SchedulerServices): void {
  if (inputPumps.size) throw new Error("Scheduler initialization requires completed teardown");
  services = next;
}
function schedulerServices(): SchedulerServices {
  if (!services) throw new Error("Scheduler services are not connected");
  return services;
}
export function hasInputPumps(): boolean { return inputPumps.size > 0; }

/** Called only after HTTP/PID publication, never during historical import. */
export function resumePendingRuntimeInputs():void{
  const pending=new InputQueueRepository(getDatabase());let afterId=0;
  for(;;){const page=pending.listPending({afterId,limit:1000});if(!page.length)break;
    for(const input of page){afterId=input.id;void pumpRuntimeInputs(input.scopeId,input.targetActorKey).catch(error=>logger.error("agent","pending input recovery failed",{inputId:input.id,error:String(error)}));}
  }
}

class RuntimeScopeRevokedError extends Error {
  constructor() { super("Member no longer has access to this execution scope"); }
}

export function drainQueuedInputsAsPrompt(instance:AgentInstance,trigger:string):boolean{
  if(!memberRuntimeAllowed(instance.memberId)||!queueDepth(instance)||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")return false;
  void pumpRuntimeInputs(instance.activeChat?.scopeId||instance.scopeId,instance.memberId).catch(error=>logger.error("agent","queued input failed",{memberId:instance.memberId,trigger,error:String(error)}));
  return true;
}

export function pumpRuntimeInputs(scopeValue:string,memberId:string):Promise<void>{
  const owner=runtimeInputOwner(scopeValue,memberId),key=instanceKey(memberId);
  const current=inputPumps.get(key);if(current)return current;
  if(!memberRuntimeAllowed(memberId)||!memberPendingInputCount(memberId))return Promise.resolve();
  if(!schedulerServices().canExecuteScope(owner.scopeId,memberId)){
    cancelPendingRuntimeInputs(owner,"execution scope access revoked");
    return Promise.resolve();
  }
  const epoch=inputScopeEpoch.get(key)??0;
  let failed=false;
  const operation=trackMemberOperation(memberId,async()=>{
    const instance=await schedulerServices().buildSession(memberId,owner.scopeId);
    if(!instance){
      if(!runtimeIsStopping()&&(inputScopeEpoch.get(key)??0)===epoch){
        const revoked=!schedulerServices().canExecuteScope(owner.scopeId,memberId);
        cancelPendingRuntimeInputs(owner,revoked?"execution scope access revoked":"runtime creation failed",revoked?"cancelled":"failed");
      }
      if(schedulerServices().canExecuteScope(owner.scopeId,memberId)&&(inputScopeEpoch.get(key)??0)===epoch){
        const member=schedulerServices().memberConfig(memberId);
        schedulerServices().postSystemNotice(owner.scopeId,member&&!isMemberConfigured(member)?memberUnconfiguredMessage(member.name):`Failed to activate member "${member?.name??memberId}": runtime unavailable.`);
      }
      return;
    }
    for(;;){
      if(!memberRuntimeAllowed(memberId)||instances.get(key)!==instance||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")break;
      if(!schedulerServices().canExecuteScope(owner.scopeId,memberId)){
        cancelPendingRuntimeInputs(owner,"execution scope access revoked");
        break;
      }
      const inputs=pendingRuntimeInputs(owner);if(!inputs.length)break;
      await runInputBatch(instance,inputs);
      notifyInputProgress(key);
    }
    if(!queueDepth(instance))schedulerServices().flushPendingReload(instance);
  }).catch(error=>{
    failed=true;
    if(!runtimeIsStopping()&&(inputScopeEpoch.get(key)??0)===epoch)cancelPendingRuntimeInputs(owner,"runtime input execution failed","failed");
    notifyInputProgress(key,error);
    if(memberRuntimeAllowed(memberId))schedulerServices().postSystemNotice(owner.scopeId,`Failed to activate member "${schedulerServices().memberConfig(memberId)?.name??memberId}": ${formatRuntimeErrorMessage(error)}`);
    throw error;
  });
  inputPumps.set(key,operation);
  return operation.finally(()=>{
    if(inputPumps.get(key)===operation)inputPumps.delete(key);
    // ① B1: a member left publicly "working" only because its queue was going
    // to drain must fall back to idle once that queued work is gone (e.g. a
    // membership removal cancelled it) — otherwise every later activation
    // reads the member as busy.
    const quiet=instances.get(key);
    if(quiet&&!quiet.promptInFlight&&!quiet.turnActive&&quiet.dispatchState==="idle"&&quiet.status!=="idle"&&!memberPendingInputCount(memberId)){
      transition(quiet,quiet.roomId,quiet.agentName,"idle","queue-cancelled");
    }
    notifyInputProgress(key);
    const live=instances.get(key);
    if(!failed&&memberRuntimeAllowed(memberId)&&memberPendingInputCount(memberId)&&(!live||(!live.compacting&&!live.promptInFlight&&!live.turnActive&&live.dispatchState==="idle"))){
      // ① B1: the member's pending work may live in several chats — wake every
      // owner scope, not just the one that started this pump.
      queueMicrotask(()=>{for(const ownerScope of pendingRuntimeInputOwners(memberId))void pumpRuntimeInputs(ownerScope,memberId).catch(error=>logger.error("agent","input wake failed",{memberId,error:String(error)}));});
    }
  });
}

const LENGTH_CONTINUATION_PROMPT="⚠ Your previous response was cut off due to output length. Continue from where you stopped and deliver the result — respond with the `chat_send` tool.";

const LENGTH_CONTINUATION_FAILED_WARNING="Member was cut off due to output length again after one automatic continuation. Automatic continuation stopped to avoid a loop; please send a new instruction if you want them to continue.";

export function isLengthStopReason(stopReason:unknown):boolean{
  if(typeof stopReason!=="string")return false;
  const value=stopReason.toLowerCase();return value==="length"||value.includes("max_tokens")||value.includes("max_output");
}

function finalizePromptSettlement(instance:AgentInstance,inputs:QueuedInput[],trigger:string,skipChatWarning:boolean):void{
  if(instances.get(instanceKey(instance.memberId))!==instance)return;
  updateDispatchState(instance,"idle",trigger);
  if(!memberRuntimeAllowed(instance.memberId))return;
  schedulerServices().applyPendingControls(instance,trigger);
  // ① B1: this batch's chat, not the build-time scope.
  const chat=instance.activeChat?.scopeId||instance.roomId;
  const chatTarget=chatTargetOf(chat);
  // Pending work does not inherit this batch's reply obligations. Complete or
  // explicitly hand off this batch before the pump chooses its next inputs.
  if(instance.lengthContinuationPending&&!skipChatWarning){
    instance.lengthContinuationPending=false;instance.lastMessageEndWasLength=false;
    if(instance.lengthContinuationAttempted){
      dismissRuntimeReplies(inputs,"continuation-exhausted","length continuation budget exhausted");
      schedulerServices().postSystemNotice(chatTarget,`Member "${instance.agentName}" ${LENGTH_CONTINUATION_FAILED_WARNING}`);
    }else{
      instance.lengthContinuationAttempted=true;
      const owed=hasRuntimeReply(runtimeInputOwner(chat,instance.memberId),inputs);
      acceptControlInput(chat,instance.memberId,{prompt:owed?LENGTH_CONTINUATION_PROMPT:"Your response was cut off due to output length. Continue the unfinished work, respecting the original reply requirements.",source:"system",trigger:"length_continuation",replySources:runtimeReplySources(inputs)},owed);
    }
    return;
  }
  const owner=runtimeInputOwner(chat,instance.memberId);
  if(!skipChatWarning&&!instance.hadErrorInTurn&&hasRuntimeReply(owner,inputs)){
    // A reply was owed but the turn ended without a chat call: nothing is
    // delivered — the debt is dismissed and the silence is made visible.
    dismissRuntimeReplies(inputs,"silent","member finished without replying");
    schedulerServices().postSystemNotice(chatTarget,`Member "${instance.agentName}" finished without replying.`);
  }
}

async function runInputBatch(instance:AgentInstance,inputs:QueuedInput[]):Promise<void>{
  if(!memberRuntimeAllowed(instance.memberId))return;
  const payloads=inputs.map(runtimeInputPayload),message=payloads.map(x=>x.prompt).join("\n\n");
  const trigger=payloads.length===1?payloads[0].trigger:"queued",token=randomUUID();
  // ① B1: this batch's chat — the instance serves it now; outbound calls follow it.
  const batchScope=inputs[0].scopeId;
  instance.activeChat.scopeId=batchScope;
  const batchTarget=chatTargetOf(batchScope);
  updateDispatchState(instance,"promptSubmitted",trigger);
  instance.promptInFlight=true;instance.hadErrorInTurn=false;instance.lastTurnError=null;instance.pendingErrorNotice=null;
  instance.lastMessageEndWasLength=false;instance.lengthContinuationPending=false;
  instance.lengthContinuationAttempted=payloads.some(payload=>payload.trigger==="length_continuation");
  let dispatched=false,outcome:"completed"|"failed"|"cancelled"="failed",failure:unknown;
  try{
    if(trigger!=="length_continuation")schedulerServices().emitEvent(batchTarget,instance.memberId,{type:"user_prompt",text:message,trigger});
    if(instance.profilePromptDirty){
      schedulerServices().refreshProfileSources(instance);
      if(!instance.handle.refreshPrompt)throw new Error("Runtime cannot refresh member identity without resetting the session.");
      instance.handle.refreshPrompt(instance.sessionSources.compiled);instance.profilePromptDirty=false;
    }
    await instance.handle.prompt(message,{beforeDispatch:(event:{attemptId:string;dispatchIndex:number;message:string})=>{
      if(!schedulerServices().canExecuteScope(batchScope,instance.memberId))throw new RuntimeScopeRevokedError();
      if(event.dispatchIndex===0){claimRuntimeInputs(inputs,event.attemptId,token);dispatched=true;}
      else{
        const continuation=acceptControlInput(batchScope,instance.memberId,{prompt:event.message,source:"system",trigger:"sdk-continuation",replySources:runtimeReplySources(inputs)},hasRuntimeReply(runtimeInputOwner(batchScope,instance.memberId),inputs)).input;
        claimRuntimeInputs([continuation],event.attemptId,token);inputs.push(continuation);
      }
    }});
    if(!dispatched)throw new Error("Runtime returned without a durable input dispatch receipt");
    outcome=instance.dispatchState==="aborting"?"cancelled":instance.hadErrorInTurn?"failed":"completed";
  }catch(error){
    if(error instanceof RuntimeScopeRevokedError){outcome="cancelled";instance.lastTurnError=null;}
    else{failure=error;outcome=instance.dispatchState==="aborting"?"cancelled":"failed";instance.hadErrorInTurn=true;instance.lastTurnError=formatRuntimeErrorMessage(error);}
  }
  instance.promptInFlight=false;
  // Provider settlement is not application publication. Publication failure cannot replay the input.
  try{finalizePromptSettlement(instance,inputs,`${trigger}_settled`,outcome!=="completed");}
  catch(error){failure=error;outcome="failed";instance.lastTurnError=formatRuntimeErrorMessage(error);updateDispatchState(instance,"idle",`${trigger}_publication_error`);}
  finally{finishRuntimeInputs(inputs,token,outcome,failure?"runtime operation or publication failed":outcome);}
  if(failure){
    logger.error("agent","input processing failed",{memberId:instance.memberId,scopeId:batchScope,error:String(failure)});
    if(instances.get(instanceKey(instance.memberId))===instance)schedulerServices().postSystemNotice(batchTarget,`Member "${instance.agentName}" error: ${formatRuntimeErrorMessage(failure)}`);
  }
  if(instances.get(instanceKey(instance.memberId))===instance&&!queueDepth(instance)&&!instance.compacting&&instance.status!=="idle")transition(instance,batchTarget,instance.agentName,"idle",`${trigger}_settled`);
}


// -- Durable input queue and actual SDK execution receipts --
export type QueuedInputStatus = "pending" | "dispatched" | "settled" | "interrupted" | "uncertain";
export interface QueuedInput extends DeliveryKey {
  id: number;
  payload: JsonValue;
  trigger: string;
  placement: "front" | "tail";
  status: QueuedInputStatus;
  createdAt: number;
  dispatchedAt: number | null;
  endedAt: number | null;
  dispatchToken: string | null;
  /** Optional correlation only. Parent owns D prepare/dispatch/acknowledge in
   * the SAME SQL transaction; this repository does not create SDK attempts. */
  executionAttemptId: string | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  result: JsonValue;
  diagnosis: string | null;
}
export interface QueuedInputOwner { id: number; scopeId: string; targetActorKey: string }
type Row = Omit<QueuedInput, "payload" | "result"> & { payloadJson: string; resultJson: string | null };
const QUEUE_SELECT = `SELECT id,scope_id AS scopeId,message_id AS messageId,target_actor_key AS targetActorKey,
  delivery_kind AS deliveryKind,payload_json AS payloadJson,trigger,placement,status,created_at AS createdAt,
  dispatched_at AS dispatchedAt,ended_at AS endedAt,dispatch_token AS dispatchToken,
  execution_attempt_id AS executionAttemptId,outcome,result_json AS resultJson,diagnosis FROM queued_inputs`;
function decode(row: Row): QueuedInput {
  const { payloadJson, resultJson, ...fields } = row;
  return { ...fields, payload: JSON.parse(payloadJson), result: resultJson === null ? null : JSON.parse(resultJson) };
}
function ownerParams(owner: QueuedInputOwner): [number, string, string] {
  if (!Number.isSafeInteger(owner.id) || owner.id < 1) throw new Error("Invalid queued input ID");
  deliveryText(owner.scopeId, "scope ID");
  deliveryText(owner.targetActorKey, "target actor key");
  return [owner.id, owner.scopeId, owner.targetActorKey];
}

/** Durable payload/state only. Never invokes closures, providers, tools or SDKs.
 * pending is safe only when parent commits beginDispatch BEFORE any external work.
 * Terminal records cannot be reset to pending; unknown dispatch is never replayed. */
export class InputQueueRepository {
  constructor(private readonly db: Database) {}

  get(owner: QueuedInputOwner): QueuedInput | undefined {
    const row = this.db.get<Row>(`${QUEUE_SELECT} WHERE id=? AND scope_id=? AND target_actor_key=?`, ...ownerParams(owner));
    return row && decode(row);
  }

  enqueue(input: DeliveryKey & { payload: JsonValue; trigger: string; placement?: "front" | "tail" }, at: number): { enqueued: boolean; input: QueuedInput } {
    deliveryTime(at);
    deliveryText(input.trigger, "input trigger");
    const placement=input.placement??"tail";
    if(placement!=="front"&&placement!=="tail")throw new Error("Invalid queued input placement");
    const key = deliveryKeyParams(input);
    const payload = canonicalJson(input.payload, "Invalid delivery JSON");
    return this.db.transaction(tx => {
      if (!new DeliveryRepository(tx).getDelivery(input)) throw new Error("Queued input requires captured delivery acceptance");
      const old = tx.get<Row>(`${QUEUE_SELECT} WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`, ...key);
      if (old) {
        if (old.payloadJson !== payload || old.trigger !== input.trigger || old.placement !== placement) throw new Error("Conflicting queued input identity");
        return { enqueued: false, input: decode(old) };
      }
      const row = tx.get<{id: number}>(`INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at,placement)
        VALUES(?,?,?,?,?,?,'pending',?,?) RETURNING id`, ...key, payload, input.trigger, at, placement)!;
      return { enqueued: true, input: new InputQueueRepository(tx).get({ id: row.id, scopeId: input.scopeId, targetActorKey: input.targetActorKey })! };
    });
  }

  getByDelivery(key: DeliveryKey): QueuedInput | undefined {
    const row=this.db.get<Row>(`${QUEUE_SELECT} WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`,...deliveryKeyParams(key));
    return row&&decode(row);
  }

  listReady(actor:{scopeId:string;targetActorKey:string},limit=1000):QueuedInput[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error("Invalid queued input page");
    deliveryText(actor.scopeId,"scope ID");deliveryText(actor.targetActorKey,"target actor key");
    return this.db.all<Row>(`${QUEUE_SELECT} WHERE scope_id=? AND target_actor_key=? AND status='pending'
      ORDER BY CASE placement WHEN 'front' THEN 0 ELSE 1 END,
      CASE WHEN placement='front' THEN id END DESC,CASE WHEN placement='tail' THEN id END ASC LIMIT ?`,actor.scopeId,actor.targetActorKey,limit).map(decode);
  }

  countPending(actor:{scopeId:string;targetActorKey:string}):number{
    return this.db.get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND target_actor_key=? AND status='pending'",actor.scopeId,actor.targetActorKey)!.n;
  }

  /** ① B1: member-level queue views — one runtime serves every chat. */
  listReadyOwners(memberId:string):string[]{
    deliveryText(memberId,"member ID");
    return this.db.all<{scopeId:string}>(`SELECT scope_id AS scopeId FROM queued_inputs
      WHERE target_actor_key=? AND status='pending' GROUP BY scope_id ORDER BY MIN(id)`,memberId).map(row=>row.scopeId);
  }

  countPendingForMember(memberId:string):number{
    deliveryText(memberId,"member ID");
    return this.db.get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE target_actor_key=? AND status='pending'",memberId)!.n;
  }

  /** Indexed keyset listing. Omitting actor lists all safe pending inputs; no dispatch. */
  listPending(options: { actor?: { scopeId: string; targetActorKey: string }; afterId?: number; limit?: number } = {}): QueuedInput[] {
    const { afterId = 0, limit = 100, actor } = options;
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid queued input page");
    const where = actor ? " AND scope_id=? AND target_actor_key=?" : "";
    return this.db.all<Row>(`${QUEUE_SELECT} WHERE status='pending' AND id>?${where} ORDER BY id LIMIT ?`,
      afterId, ...(actor ? [actor.scopeId, actor.targetActorKey] : []), limit).map(decode);
  }

  /** One winner can dispatch. false means absent/wrong owner/not pending. The
   * caller must check it, and wait for OUTER COMMIT before invoking external IO. */
  beginDispatch(owner: QueuedInputOwner, dispatch: { token: string; executionAttemptId: string | null }, at: number): boolean {
    deliveryTime(at);
    deliveryText(dispatch.token, "dispatch token");
    if (dispatch.executionAttemptId !== null) deliveryText(dispatch.executionAttemptId, "execution attempt ID");
    return !!this.db.get(`UPDATE queued_inputs SET status='dispatched',dispatched_at=?,dispatch_token=?,execution_attempt_id=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status='pending' RETURNING id`,
    at, dispatch.token, dispatch.executionAttemptId, ...ownerParams(owner));
  }

  /** Only a verified SDK/provider settlement belongs here, not routing callback
   * acceptance. This does not settle chat obligations or imply tool side effects
   * were atomic. The token guards stale/other-dispatch callbacks. */
  settle(owner: QueuedInputOwner, token: string, result: { outcome: "completed" | "failed" | "cancelled"; result: JsonValue }, at: number): boolean {
    deliveryTime(at);
    deliveryText(token, "dispatch token");
    if (!["completed", "failed", "cancelled"].includes(result.outcome)) throw new Error("Invalid queued input outcome");
    const json = canonicalJson(result.result, "Invalid delivery JSON");
    return !!this.db.get(`UPDATE queued_inputs SET status='settled',ended_at=?,outcome=?,result_json=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status='dispatched' AND dispatch_token=? RETURNING id`,
    at, result.outcome, json, ...ownerParams(owner), token);
  }

  /** Cancelling pending work proves it never dispatched. Interrupting dispatched
   * work only records uncertainty, never a successful SDK cancellation. */
  interrupt(owner: QueuedInputOwner, expected: { status: "pending" } | { status: "dispatched"; token: string }, diagnosis: string, at: number): boolean {
    deliveryTime(at);
    deliveryText(diagnosis, "interruption diagnosis");
    if (expected.status !== "pending" && expected.status !== "dispatched") throw new Error("Invalid interruption source state");
    if (expected.status === "dispatched") deliveryText(expected.token, "dispatch token");
    return !!this.db.get(`UPDATE queued_inputs SET status=?,ended_at=?,diagnosis=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status=?${expected.status === "dispatched" ? " AND dispatch_token=?" : ""} RETURNING id`,
    expected.status === "pending" ? "interrupted" : "uncertain", at, diagnosis, ...ownerParams(owner), expected.status,
    ...(expected.status === "dispatched" ? [expected.token] : []));
  }

  /** Explicit startup-only sweep after runtime quiescence. Safe pending payloads
   * survive unchanged; no callbacks, queue reconstruction or automatic replay. */
  recoverStartup(at: number): { uncertain: number } {
    deliveryTime(at);
    return this.db.transaction(tx => ({ uncertain: tx.all(`UPDATE queued_inputs SET status='uncertain',ended_at=?,
      diagnosis='dispatch outcome uncertain after service restart; not replayed'
      WHERE status='dispatched' RETURNING id`, at).length }));
  }
}

export interface ExecutionAttempt {
  id: string; memberId: string; scopeId: string;
  operation: "input" | "session-create" | "session-fork" | "external";
  externalReference: string | null;
  status: "prepared" | "dispatched" | "acknowledged" | "interrupted";
  startedAt: number; dispatchedAt: number | null; endedAt: number | null; diagnosis: string | null;
}
const ATTEMPT_SELECT = `SELECT id,member_id AS memberId,scope_id AS scopeId,operation,external_reference AS externalReference,
  status,started_at AS startedAt,dispatched_at AS dispatchedAt,ended_at AS endedAt,diagnosis FROM execution_attempts`;
/** Explicit acknowledgement checkpoints, not an SDK history mirror or a replay queue.
 * Commit dispatch BEFORE external IO; acknowledge only after the caller verifies receipt.
 * A restart cannot know whether external IO happened, even for a 'prepared' row. */
export class ExecutionAttemptRepository {
  constructor(private readonly db: Database) {}
  get(id: string, memberId: string): ExecutionAttempt | undefined {
    return this.db.get<ExecutionAttempt>(`${ATTEMPT_SELECT} WHERE id=? AND member_id=?`, id, memberId);
  }
  prepare(a: Omit<ExecutionAttempt, "status" | "dispatchedAt" | "endedAt" | "diagnosis">): void {
    this.db.run(`INSERT INTO execution_attempts(id,member_id,scope_id,operation,external_reference,status,started_at)
      VALUES(?,?,?,?,?,'prepared',?)`, a.id, a.memberId, assertExecutionOwner(this.db, a.memberId, a.scopeId), a.operation, a.externalReference, a.startedAt);
  }
  markDispatched(id: string, memberId: string, at: number): void {
    if (!this.db.get("UPDATE execution_attempts SET status='dispatched',dispatched_at=? WHERE id=? AND member_id=? AND status='prepared' RETURNING id", at, id, memberId)) {
      throw new Error(`Execution dispatch rejected: ${id}`);
    }
  }
  acknowledge(id: string, memberId: string, at: number): void {
    if (!this.db.get("UPDATE execution_attempts SET status='acknowledged',ended_at=? WHERE id=? AND member_id=? AND status='dispatched' RETURNING id", at, id, memberId)) {
      throw new Error(`Execution acknowledgement rejected: ${id}`);
    }
  }
  /** A failed/cancelled operation is not a successful acknowledgement or safe replay. */
  interrupt(id:string,memberId:string,at:number,diagnosis:string):boolean{
    if(!diagnosis.trim())throw new Error("Execution interruption requires a diagnosis");
    return !!this.db.get("UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis=? WHERE id=? AND member_id=? AND status IN ('prepared','dispatched') RETURNING id",at,diagnosis,id,memberId);
  }
  interruptIncomplete(at: number): number {
    return this.db.transaction(tx => tx.all(`UPDATE execution_attempts SET status='interrupted',ended_at=?,
      diagnosis='completion uncertain after service restart; not replayed' WHERE status IN ('prepared','dispatched') RETURNING id`, at).length);
  }
}

/** One actual SDK call, not completion of a parent input, reply, or background task. */
export class SdkExecutionAttempt {
  private uncertainty: string | undefined;
  private interrupted = false;

  constructor(readonly id: string, private readonly memberId: string, private readonly db: Database) {}

  /** Stream callbacks collect evidence without throwing database errors into the SDK emitter. */
  noteUncertain(reason: string): void {
    this.uncertainty ??= `${reason}; SDK completion uncertain; not replayed`;
  }

  /** Targeted, guarded live interruption. Never sweeps other in-flight operations. */
  interrupt(reason: string): void {
    this.noteUncertain(reason);
    if (this.interrupted) return;
    this.db.assertOutsideTransaction();
    if (!this.db.get(`UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis=?
      WHERE id=? AND member_id=? AND status IN ('prepared','dispatched') RETURNING id`,
    Date.now(), this.uncertainty, this.id, this.memberId)) {
      throw new Error(`SDK execution interruption rejected: ${this.id}`);
    }
    this.interrupted = true;
  }

  /** Resolution alone is insufficient when the SDK streamed a provider error or abort. */
  settle(): void {
    this.db.assertOutsideTransaction();
    if (this.uncertainty) this.interrupt(this.uncertainty);
    else new ExecutionAttemptRepository(this.db).acknowledge(this.id, this.memberId, Date.now());
  }

  fail(error: unknown): never {
    try { this.interrupt(`SDK call failed: ${error instanceof Error ? error.message : String(error)}`); }
    catch (recordError) { throw new AggregateError([error, recordError], "SDK call and execution recording failed"); }
    throw error;
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      this.settle();
      return result;
    } catch (error) { return this.fail(error); }
  }
}

/** Short SQL dispatch transaction commits before any SDK/resource IO. No implicit DB or owner fallback. */
export class SdkExecutionService {
  constructor(private readonly memberId: string, private readonly scopeId: string, private readonly db = getDatabase()) {}

  dispatch(operation: ExecutionAttempt["operation"], externalReference: string, beforeDispatch?: (attemptId: string) => void): SdkExecutionAttempt {
    this.db.assertOutsideTransaction();
    // Reject native async hooks before even their synchronous prefix can run.
    if (beforeDispatch?.constructor.name === "AsyncFunction") throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
    const id = randomUUID();
    this.db.transaction(tx => {
      const repo = new ExecutionAttemptRepository(tx);
      repo.prepare({ id, memberId: this.memberId, scopeId: this.scopeId, operation, externalReference, startedAt: Date.now() });
      repo.markDispatched(id, this.memberId, Date.now());
      const result: unknown = beforeDispatch?.(id);
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
      }
    });
    return new SdkExecutionAttempt(id, this.memberId, this.db);
  }
}
