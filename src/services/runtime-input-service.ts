import {randomUUID} from "node:crypto";
import {getDatabase} from "../storage/database.js";
import {DeliveryRepository,type CapturedMessage,type DeliveryKey,type DeliveryJson} from "../storage/repositories/delivery-repository.js";
import {InputQueueRepository,type QueuedInput} from "../storage/repositories/input-queue-repository.js";
import {ReplyObligationRepository,type ReplyDisposition} from "../storage/repositories/reply-obligation-repository.js";
import {ExecutionAttemptRepository} from "../storage/repositories/execution-attempt-repository.js";
import {executionScopeId,assertExecutionOwner} from "../storage/repositories/execution-identity.js";

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
    const {input}=queue.enqueue({...key,payload:payload as unknown as DeliveryJson,trigger:payload.trigger,placement:options.placement},at);
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
    const result=new InputQueueRepository(db).enqueue({...key,payload:payload as unknown as DeliveryJson,trigger:payload.trigger,placement},at);
    onAccepted?.();return {input:result.input,accepted:result.enqueued};
  });
}

export function pendingRuntimeInputs(owner:RuntimeInputOwner):QueuedInput[]{return new InputQueueRepository(getDatabase()).listReady(owner);}
export function pendingRuntimeInputCount(owner:RuntimeInputOwner):number{return new InputQueueRepository(getDatabase()).countPending(owner);}
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
