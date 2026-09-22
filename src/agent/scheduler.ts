import { randomUUID } from "node:crypto";
import { canonicalJson, type JsonValue } from "../kernel/json.js";
import { getDatabase, type Database } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { handleAgentEvent as processEvent, type AgentHistoryEvent } from "./events.js";
import type { AgentMemberConfig, AgentPromptSnapshot, AgentStreamEvent } from "./types.js";
import {
  formatRuntimeErrorMessage, instanceKey, instances, isMemberConfigured,
  memberRuntimeAllowed, memberUnconfiguredMessage, runtimeIsStopping,
  trackMemberOperation, transition, updateDispatchState, type AgentInstance,
} from "./instance.js";
export interface PreparedRuntimeInput {
  prompt: string;
  source?: "room_mention" | "private_instruction" | "system";
  trigger: string;
  replySources?: string[];
}
export interface AgentAdmission {
  memberId: string;
  sourceRef: string;
  idempotencyKey: string;
  input: PreparedRuntimeInput;
  replyExpected: boolean;
}
export interface AgentAdmissionReceipt { enqueued: boolean; inputId: number; interrupt: boolean }
export interface AgentWakeReceipt { inputId: number; interrupt: boolean }
export type QueuedInputStatus = "pending" | "dispatched" | "settled" | "interrupted" | "uncertain";
export interface QueuedInput {
  id: number;
  memberId: string;
  idempotencyKey: string;
  sourceRef: string | null;
  payload: JsonValue;
  trigger: string;
  replyExpected: boolean;
  placement: "front" | "tail";
  status: QueuedInputStatus;
  createdAt: number;
  dispatchedAt: number | null;
  endedAt: number | null;
  dispatchToken: string | null;
  executionAttemptId: string | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  result: JsonValue;
  diagnosis: string | null;
}
type QueueRow = Omit<QueuedInput, "payload" | "result" | "replyExpected"> & {
  payloadJson: string; resultJson: string | null; replyExpected: number;
};
const QUEUE_SELECT = `SELECT id,member_id AS memberId,idempotency_key AS idempotencyKey,
  source_ref AS sourceRef,payload_json AS payloadJson,trigger,reply_expected AS replyExpected,
  placement,status,created_at AS createdAt,dispatched_at AS dispatchedAt,ended_at AS endedAt,
  dispatch_token AS dispatchToken,execution_attempt_id AS executionAttemptId,outcome,
  result_json AS resultJson,diagnosis FROM queued_inputs`;
function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid ${label}`);
  return value;
}
function decodeInput(row: QueueRow): QueuedInput {
  const { payloadJson, resultJson, replyExpected, ...fields } = row;
  return { ...fields, replyExpected: replyExpected === 1, payload: JSON.parse(payloadJson), result: resultJson === null ? null : JSON.parse(resultJson) };
}
export function readQueuedInput(db: Database, id: number, memberId: string): QueuedInput | undefined {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid queued input ID");
  const row = db.get<QueueRow>(`${QUEUE_SELECT} WHERE id=? AND member_id=?`, id, requiredText(memberId, "member ID"));
  return row && decodeInput(row);
}
function inputByIdentity(db: Database, memberId: string, idempotencyKey: string): QueuedInput | undefined {
  const row = db.get<QueueRow>(`${QUEUE_SELECT} WHERE member_id=? AND idempotency_key=?`, memberId, idempotencyKey);
  return row && decodeInput(row);
}
function readyInputs(db: Database, memberId: string, sourceRef?: string | null, limit = 1_000): QueuedInput[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid queued input page");
  const source = sourceRef === undefined ? "" : sourceRef === null ? " AND source_ref IS NULL" : " AND source_ref=?";
  return db.all<QueueRow>(`${QUEUE_SELECT} WHERE member_id=? AND status='pending'${source}
    ORDER BY CASE placement WHEN 'front' THEN 0 ELSE 1 END,
    CASE WHEN placement='front' THEN id END DESC,CASE WHEN placement='tail' THEN id END ASC LIMIT ?`,
  memberId, ...(sourceRef === undefined || sourceRef === null ? [] : [sourceRef]), limit).map(decodeInput);
}

type InternalAdmission = Omit<AgentAdmission, "sourceRef"> & { sourceRef: string | null };

function enqueueAdmission(db: Database, admission: InternalAdmission, forcedPlacement?: "front" | "tail"): AgentAdmissionReceipt {
  const memberId = requiredText(admission.memberId, "member ID");
  const sourceRef = admission.sourceRef === null ? null : requiredText(admission.sourceRef, "source reference");
  const idempotencyKey = requiredText(admission.idempotencyKey, "idempotency key");
  if (!admission.input || typeof admission.input.prompt !== "string" || !admission.input.prompt.trim()) throw new Error("Agent admission requires a prepared prompt");
  requiredText(admission.input.trigger, "input trigger");
  const payload = canonicalJson(admission.input as unknown as JsonValue, "Invalid agent input JSON");
  const existing = inputByIdentity(db, memberId, idempotencyKey);
  if (existing) {
    if (existing.sourceRef !== sourceRef || canonicalJson(existing.payload, "Invalid stored agent input") !== payload ||
        existing.trigger !== admission.input.trigger || existing.replyExpected !== admission.replyExpected) throw new Error("Conflicting agent admission identity");
    return { enqueued: false, inputId: existing.id, interrupt: false };
  }
  const instance = instances.get(instanceKey(memberId));
  const busy = !!instance && (instance.status === "working" || instance.dispatchState !== "idle" || instance.promptInFlight || instance.turnActive);
  const interrupt = forcedPlacement === undefined && busy && !instance!.compacting;
  const placement = forcedPlacement ?? (interrupt ? "front" : "tail");
  const row = db.get<{id:number}>(`INSERT INTO queued_inputs(
      member_id,idempotency_key,source_ref,payload_json,trigger,reply_expected,placement,status,created_at
    ) VALUES(?,?,?,?,?,?,?,'pending',?) RETURNING id`, memberId,idempotencyKey,sourceRef,payload,
  admission.input.trigger,admission.replyExpected ? 1 : 0,placement,Date.now());
  if (!row) throw new Error("Agent admission did not produce an input receipt");
  return { enqueued: true, inputId: row.id, interrupt };
}

/** Agent-owned half of chat admission. Caller owns the outer synchronous transaction. */
export function acceptAgentAdmission(db: Database, admission: AgentAdmission): AgentAdmissionReceipt {
  return enqueueAdmission(db, admission);
}

/** Internal control/continuation input; chat facts are never invented. */
export function acceptControlInput(
  sourceRef: string | null, memberId: string, input: PreparedRuntimeInput, replyExpected: boolean,
  placement: "front" | "tail" = "tail", onAccepted?: () => void,
): { input: QueuedInput; accepted: boolean } {
  const db = getDatabase();
  return db.transaction(tx => {
    const receipt = enqueueAdmission(tx, {
      memberId, sourceRef, idempotencyKey: `control:${randomUUID()}`, input, replyExpected,
    }, placement);
    onAccepted?.();
    return { input: readQueuedInput(tx, receipt.inputId, memberId)!, accepted: receipt.enqueued };
  });
}

export function runtimeInputPayload(input: QueuedInput): PreparedRuntimeInput {
  const value = input.payload as unknown as PreparedRuntimeInput;
  if (!value || typeof value.prompt !== "string" || typeof value.trigger !== "string") throw new Error(`Invalid durable runtime input: ${input.id}`);
  return value;
}
export function runtimeReplySources(inputs: readonly QueuedInput[]): string[] {
  return [...new Set(inputs.flatMap(input => runtimeInputPayload(input).replySources ?? []))];
}
export function pendingRuntimeInputSources(memberId: string): Array<string | null> {
  return getDatabase().all<{sourceRef:string|null}>(`SELECT source_ref AS sourceRef FROM queued_inputs
    WHERE member_id=? AND status='pending' GROUP BY source_ref ORDER BY MIN(id)`, memberId).map(row => row.sourceRef);
}
export const pendingRuntimeInputOwners = pendingRuntimeInputSources;
export function memberPendingInputCount(memberId: string): number {
  return getDatabase().get<{n:number}>("SELECT COUNT(*) n FROM queued_inputs WHERE member_id=? AND status='pending'", memberId)!.n;
}
export function queueDepth(instance: AgentInstance): number { return memberPendingInputCount(instance.memberId); }

function beginDispatch(db: Database, input: QueuedInput, token: string, attemptId: string): boolean {
  return !!db.get(`UPDATE queued_inputs SET status='dispatched',dispatched_at=?,dispatch_token=?,execution_attempt_id=?
    WHERE id=? AND member_id=? AND status='pending' RETURNING id`, Date.now(), token, attemptId, input.id, input.memberId);
}
export function claimRuntimeInputs(inputs: readonly QueuedInput[], attemptId: string, dispatchToken: string): void {
  const db = getDatabase();
  db.transaction(tx => {
    for (const input of inputs) if (!beginDispatch(tx,input,dispatchToken,attemptId)) throw new Error(`Runtime input already dispatched: ${input.id}`);
  });
}
function settleInput(db: Database, input: QueuedInput, token: string, outcome: "completed"|"failed"|"cancelled", diagnosis: string): void {
  const current = readQueuedInput(db,input.id,input.memberId);
  if (current?.status === "pending") {
    db.run("UPDATE queued_inputs SET status='interrupted',ended_at=?,diagnosis=? WHERE id=? AND member_id=? AND status='pending'",Date.now(),diagnosis,input.id,input.memberId);
    return;
  }
  if (current?.status !== "dispatched" || !db.get(`UPDATE queued_inputs SET status='settled',ended_at=?,outcome=?,result_json='null'
      WHERE id=? AND member_id=? AND status='dispatched' AND dispatch_token=? RETURNING id`,Date.now(),outcome,input.id,input.memberId,token)) {
    throw new Error(`Runtime input settlement lost ownership: ${input.id}`);
  }
}
export function finishRuntimeInputs(inputs: readonly QueuedInput[], token: string, outcome: "completed"|"failed"|"cancelled", diagnosis: string): void {
  getDatabase().transaction(tx => { for (const input of inputs) settleInput(tx,input,token,outcome,diagnosis); });
}
export function cancelPendingRuntimeInputs(memberId: string, diagnosis: string, sourceRef?: string | null): number {
  requiredText(diagnosis,"cancellation diagnosis");
  const db=getDatabase();
  return db.transaction(tx => {
    const source=sourceRef===undefined?"":sourceRef===null?" AND source_ref IS NULL":" AND source_ref=?";
    const rows=tx.all<{id:number}>(`UPDATE queued_inputs SET status='interrupted',ended_at=?,diagnosis=?
      WHERE member_id=? AND status='pending'${source} RETURNING id`,Date.now(),diagnosis,memberId,...(sourceRef===undefined||sourceRef===null?[]:[sourceRef]));
    if(rows.length)schedulerServices().dismissReplies(tx,memberId,sourceRef,diagnosis,"cancelled");
    return rows.length;
  });
}

export function recoverRuntimeInputState(): void {
  const db=getDatabase();
  db.transaction(tx => {
    const at=Date.now();
    tx.run(`UPDATE queued_inputs SET status='uncertain',ended_at=?,diagnosis='dispatch outcome uncertain after service restart; not replayed'
      WHERE status='dispatched'`,at);
    tx.run(`UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis='completion uncertain after service restart; not replayed'
      WHERE status IN ('prepared','dispatched')`,at);
  });
}

const inputPumps=new Map<string,Promise<void>>();
const inputProgress=new Map<string,Set<(error?:unknown)=>void>>();
const inputEpoch=new Map<string,number>();
export function hasInputPumps():boolean{return inputPumps.size>0;}
export function invalidateInputScope(memberId:string):void{inputEpoch.set(memberId,(inputEpoch.get(memberId)??0)+1);}
function notifyInputProgress(memberId:string,error?:unknown):void{for(const notify of [...(inputProgress.get(memberId)??[])])notify(error);}
function inputHasContinuation(input:QueuedInput):boolean{
  const replySources=runtimeReplySources([input]);
  if(!replySources.length)return false;
  return !!getDatabase().get(`SELECT 1 FROM queued_inputs q JOIN json_each(q.payload_json,'$.replySources') s
    WHERE q.member_id=? AND q.id<>? AND q.status IN ('pending','dispatched')
      AND s.value IN (${replySources.map(()=>"?").join(",")}) LIMIT 1`,input.memberId,input.id,...replySources);
}
export function waitForInputSettlement(input:QueuedInput,operation:Promise<void>):Promise<void>{
  return new Promise((resolve,reject)=>{
    const listeners=inputProgress.get(input.memberId)??new Set<(error?:unknown)=>void>();inputProgress.set(input.memberId,listeners);
    let finished=false;
    const cleanup=()=>{finished=true;listeners.delete(check);if(!listeners.size&&inputProgress.get(input.memberId)===listeners)inputProgress.delete(input.memberId);};
    const check=(error?:unknown)=>{if(finished)return;try{if(error)throw error;if(!memberRuntimeAllowed(input.memberId)){cleanup();resolve();return;}const row=readQueuedInput(getDatabase(),input.id,input.memberId);if(row&&row.status!=="pending"&&row.status!=="dispatched"&&!inputHasContinuation(input)){cleanup();resolve();}}catch(reason){cleanup();reject(reason);}};
    listeners.add(check);void operation.then(()=>check(),check);
  });
}

export interface SchedulerServices {
  buildSession(memberId:string):Promise<AgentInstance|null>;
  memberConfig(memberId:string):AgentMemberConfig|null;
  authorizeExecution(memberId:string,sourceRef:string|null):boolean;
  postSystemNotice(sourceRef:string,text:string):void;
  emitEvent(sourceRef:string|null,memberId:string,event:AgentHistoryEvent):void;
  loadProfileSources(memberId:string):{agentName:string;compiled:AgentPromptSnapshot};
  applyPendingControls(instance:AgentInstance,trigger:string):void;
  interruptAccepted(instance:AgentInstance,sourceRef:string):void;
  flushPendingReload(instance:AgentInstance):void;
  hasPendingReply(db:Database,memberId:string,sourceRef:string,replySources:string[]):boolean;
  dismissReplies(db:Database,memberId:string,sourceRef:string|null|undefined,diagnosis:string,disposition:"failed"|"cancelled"|"silent"|"continuation-exhausted"):void;
}
let services:SchedulerServices|undefined;
export function configureScheduler(next:SchedulerServices):void{if(inputPumps.size)throw new Error("Scheduler initialization requires completed teardown");services=next;}
function schedulerServices():SchedulerServices{if(!services)throw new Error("Scheduler services are not connected");return services;}
class ExecutionAuthorizationRevokedError extends Error{constructor(){super("Member no longer has access to this input source");}}

export function wakeAgent(memberId:string,receipt:AgentWakeReceipt):Promise<void>{
  const input=readQueuedInput(getDatabase(),receipt.inputId,memberId);
  if(!input||input.status!=="pending")return Promise.resolve();
  if(!schedulerServices().authorizeExecution(memberId,input.sourceRef)){
    cancelPendingRuntimeInputs(memberId,"execution authorization revoked",input.sourceRef);return Promise.resolve();
  }
  const instance=instances.get(instanceKey(memberId));
  if(receipt.interrupt&&instance&&input.sourceRef)schedulerServices().interruptAccepted(instance,input.sourceRef);
  return pumpRuntimeInputs(memberId);
}
export function resumePendingRuntimeInputs():void{
  for(const {memberId} of getDatabase().all<{memberId:string}>("SELECT member_id AS memberId FROM queued_inputs WHERE status='pending' AND member_id IS NOT NULL GROUP BY member_id"))
    void pumpRuntimeInputs(memberId).catch(error=>logger.error("agent","pending input recovery failed",{memberId,error:String(error)}));
}
export function drainQueuedInputsAsPrompt(instance:AgentInstance,trigger:string):boolean{
  if(!memberRuntimeAllowed(instance.memberId)||!queueDepth(instance)||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")return false;
  void pumpRuntimeInputs(instance.memberId).catch(error=>logger.error("agent","queued input failed",{memberId:instance.memberId,trigger,error:String(error)}));return true;
}
export function pumpRuntimeInputs(memberId:string):Promise<void>{
  const key=instanceKey(memberId),current=inputPumps.get(key);if(current)return current;
  if(!memberRuntimeAllowed(memberId)||!memberPendingInputCount(memberId))return Promise.resolve();
  const epoch=inputEpoch.get(key)??0;let failed=false;
  const operation=trackMemberOperation(memberId,async()=>{
    let instance:AgentInstance|null=null;
    for(;;){
      if(!memberRuntimeAllowed(memberId)||(inputEpoch.get(key)??0)!==epoch)break;
      const input=readyInputs(getDatabase(),memberId,undefined,1)[0];if(!input)break;
      if(!schedulerServices().authorizeExecution(memberId,input.sourceRef)){
        cancelPendingRuntimeInputs(memberId,"execution authorization revoked",input.sourceRef);continue;
      }
      instance??=await schedulerServices().buildSession(memberId);
      if(!instance){
        cancelPendingRuntimeInputs(memberId,"runtime creation failed");
        const member=schedulerServices().memberConfig(memberId);
        if(input.sourceRef)schedulerServices().postSystemNotice(input.sourceRef,member&&!isMemberConfigured(member)?memberUnconfiguredMessage(member.name):`Failed to activate member "${member?.name??memberId}": runtime unavailable.`);
        break;
      }
      // Authorization may be revoked while the member runtime is being built.
      // Recheck before the input reaches any runtime API; beforeDispatch checks
      // once more at the provider boundary.
      if(!schedulerServices().authorizeExecution(memberId,input.sourceRef)){
        cancelPendingRuntimeInputs(memberId,"execution authorization revoked",input.sourceRef);continue;
      }
      if(instances.get(key)!==instance||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")break;
      await runInputBatch(instance,[input]);notifyInputProgress(memberId);
    }
    if(instance&&!queueDepth(instance))schedulerServices().flushPendingReload(instance);
  }).catch(error=>{
    failed=true;notifyInputProgress(memberId,error);
    if(!runtimeIsStopping()&&(inputEpoch.get(key)??0)===epoch)cancelPendingRuntimeInputs(memberId,"runtime input execution failed");
    throw error;
  });
  inputPumps.set(key,operation);
  return operation.finally(()=>{
    if(inputPumps.get(key)===operation)inputPumps.delete(key);notifyInputProgress(memberId);
    const live=instances.get(key);
    if(!failed&&memberRuntimeAllowed(memberId)&&memberPendingInputCount(memberId)&&(!live||(!live.compacting&&!live.promptInFlight&&!live.turnActive&&live.dispatchState==="idle")))
      queueMicrotask(()=>void pumpRuntimeInputs(memberId).catch(error=>logger.error("agent","input wake failed",{memberId,error:String(error)})));
  });
}

function hasPendingReply(inputs:QueuedInput[]):boolean{
  const first=inputs[0];return !!first.sourceRef&&inputs.some(input=>input.replyExpected)&&schedulerServices().hasPendingReply(getDatabase(),first.memberId,first.sourceRef,runtimeReplySources(inputs));
}
function finalizePromptSettlement(instance:AgentInstance,inputs:QueuedInput[],trigger:string,skipWarning:boolean):void{
  if(instances.get(instanceKey(instance.memberId))!==instance)return;
  updateDispatchState(instance,"idle",trigger);if(!memberRuntimeAllowed(instance.memberId))return;
  schedulerServices().applyPendingControls(instance,trigger);
  const sourceRef=inputs[0].sourceRef;
  if(!skipWarning&&!instance.hadErrorInTurn&&hasPendingReply(inputs)){
    getDatabase().transaction(db=>schedulerServices().dismissReplies(db,instance.memberId,sourceRef,"member finished without replying","silent"));
    if(sourceRef)schedulerServices().postSystemNotice(sourceRef,`Member "${instance.agentName}" finished without replying.`);
  }
}
async function runInputBatch(instance:AgentInstance,inputs:QueuedInput[]):Promise<void>{
  const payloads=inputs.map(runtimeInputPayload),message=payloads.map(item=>item.prompt).join("\n\n"),trigger=payloads.length===1?payloads[0].trigger:"queued";
  const sourceRef=inputs[0].sourceRef,token=randomUUID();instance.activeSourceRef=sourceRef;
  updateDispatchState(instance,"promptSubmitted",trigger);instance.promptInFlight=true;instance.hadErrorInTurn=false;instance.lastTurnError=null;instance.pendingErrorNotice=null;
  let dispatched=false,outcome:"completed"|"failed"|"cancelled"="failed",failure:unknown;
  try{
    schedulerServices().emitEvent(sourceRef,instance.memberId,{type:"user_prompt",text:message,trigger});
    if(instance.profilePromptDirty){const sources=schedulerServices().loadProfileSources(instance.memberId);instance.agentName=sources.agentName;instance.sessionSources.compiled=sources.compiled;instance.handle.refreshPrompt(sources.compiled);instance.profilePromptDirty=false;}
    await instance.handle.prompt(message,{beforeDispatch:event=>{
      if(!schedulerServices().authorizeExecution(instance.memberId,sourceRef))throw new ExecutionAuthorizationRevokedError();
      if(event.dispatchIndex===0){claimRuntimeInputs(inputs,event.attemptId,token);dispatched=true;}
      else{const continuation=acceptControlInput(sourceRef,instance.memberId,{prompt:event.message,source:"system",trigger:"sdk-continuation",replySources:runtimeReplySources(inputs)},hasPendingReply(inputs)).input;claimRuntimeInputs([continuation],event.attemptId,token);inputs.push(continuation);}
    }});
    if(!dispatched)throw new Error("Runtime returned without a durable input dispatch receipt");
    outcome=instance.dispatchState==="aborting"?"cancelled":instance.hadErrorInTurn?"failed":"completed";
  }catch(error){if(error instanceof ExecutionAuthorizationRevokedError){outcome="cancelled";}else{failure=error;outcome=instance.dispatchState==="aborting"?"cancelled":"failed";instance.hadErrorInTurn=true;instance.lastTurnError=formatRuntimeErrorMessage(error);}}
  instance.promptInFlight=false;
  try{finalizePromptSettlement(instance,inputs,`${trigger}_settled`,outcome!=="completed");}
  catch(error){failure=error;outcome="failed";instance.lastTurnError=formatRuntimeErrorMessage(error);updateDispatchState(instance,"idle",`${trigger}_publication_error`);}
  finally{finishRuntimeInputs(inputs,token,outcome,failure?"runtime operation or publication failed":outcome);}
  if(failure&&sourceRef&&instances.get(instanceKey(instance.memberId))===instance)schedulerServices().postSystemNotice(sourceRef,`Member "${instance.agentName}" error: ${formatRuntimeErrorMessage(failure)}`);
  if(instances.get(instanceKey(instance.memberId))===instance&&!queueDepth(instance)&&!instance.compacting&&instance.status!=="idle")transition(instance,sourceRef,instance.agentName,"idle",`${trigger}_settled`);
  if(instance.activeSourceRef===sourceRef)instance.activeSourceRef=null;
}

export interface ExecutionAttempt {
  id:string;memberId:string;sourceRef:string|null;operation:"input"|"session-create"|"session-fork"|"external";
  externalReference:string|null;status:"prepared"|"dispatched"|"acknowledged"|"interrupted";
  startedAt:number;dispatchedAt:number|null;endedAt:number|null;diagnosis:string|null;
}
export class SdkExecutionAttempt {
  private uncertainty:string|undefined;private interrupted=false;
  constructor(readonly id:string,private readonly memberId:string,private readonly db:Database){}
  noteUncertain(reason:string):void{this.uncertainty??=`${reason}; SDK completion uncertain; not replayed`;}
  interrupt(reason:string):void{this.noteUncertain(reason);if(this.interrupted)return;this.db.assertOutsideTransaction();if(!this.db.get(`UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis=? WHERE id=? AND member_id=? AND status IN ('prepared','dispatched') RETURNING id`,Date.now(),this.uncertainty,this.id,this.memberId))throw new Error(`SDK execution interruption rejected: ${this.id}`);this.interrupted=true;}
  settle():void{this.db.assertOutsideTransaction();if(this.uncertainty)this.interrupt(this.uncertainty);else if(!this.db.get("UPDATE execution_attempts SET status='acknowledged',ended_at=? WHERE id=? AND member_id=? AND status='dispatched' RETURNING id",Date.now(),this.id,this.memberId))throw new Error(`Execution acknowledgement rejected: ${this.id}`);}
  fail(error:unknown):never{try{this.interrupt(`SDK call failed: ${error instanceof Error?error.message:String(error)}`);}catch(recordError){throw new AggregateError([error,recordError],"SDK call and execution recording failed");}throw error;}
  async run<T>(call:()=>Promise<T>):Promise<T>{try{const result=await call();this.settle();return result;}catch(error){return this.fail(error);}}
}
export function dispatchSdkExecution(memberId:string,sourceRef:string|null,operation:ExecutionAttempt["operation"],externalReference:string,beforeDispatch?:(attemptId:string)=>void):SdkExecutionAttempt{
  const db=getDatabase();db.assertOutsideTransaction();
  if(!schedulerServices().authorizeExecution(memberId,sourceRef))throw new ExecutionAuthorizationRevokedError();
  if(beforeDispatch?.constructor.name==="AsyncFunction")throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
  const id=randomUUID();db.transaction(tx=>{tx.run(`INSERT INTO execution_attempts(id,member_id,source_ref,operation,external_reference,status,started_at) VALUES(?,?,?,?,?,'prepared',?)`,id,memberId,sourceRef,operation,externalReference,Date.now());tx.run("UPDATE execution_attempts SET status='dispatched',dispatched_at=? WHERE id=? AND member_id=? AND status='prepared'",Date.now(),id,memberId);const result:unknown=beforeDispatch?.(id);if(result!=null&&typeof(result as PromiseLike<unknown>).then==="function"){void Promise.resolve(result).catch(()=>{});throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");}});return new SdkExecutionAttempt(id,memberId,db);
}
// -- SDK event subscription and turn/compaction lifecycle --
// -- Instance event wiring (single implementation for room and DM scopes) --

/**
 * THE one instance event subscription. Room and DM instances share this wiring;
 * the only scope difference is the notification address: `sourceRef` is the bare
 * room id for room scope and "dm:<memberId>" for DM scope, and postMessage
 * routes by that prefix (room store vs member-owned DM store). Failure notices
 * therefore reach the user in both UIs (G1), and lifecycle handling (length
 * continuation, compaction, unexpected exit, queued-input draining) cannot
 * drift between scopes.
 */
export function recordMemberRuntimeEvent(sourceRef:string|null,memberId:string,event:AgentHistoryEvent):void{
  const key=instanceKey(memberId),instance=instances.get(key);
  processEvent(sourceRef,memberId,key,event as AgentStreamEvent,instance?.eventBuffer??[],memberId);
}
export function wireInstanceEvents(instance: AgentInstance): void {
  const key = instanceKey(instance.memberId), memberId = instance.memberId;
  const unsubscribe = instance.handle.subscribe((event: AgentStreamEvent) => {
    const memberName = instance.agentName;
    const sourceRef = instance.activeSourceRef;
    const newStatus = processEvent(sourceRef, memberName, key, event, instance.eventBuffer, memberId, instance.appliedModel);
    if (event.type === "agent_start") {
      instance.turnActive = true;
      if(instance.dispatchState!=="aborting")updateDispatchState(instance, "running", event.type);
    } else if (event.type === "agent_end") {
      // pi session-level retry: willRetry agent_end is not a real turn end — keep
      // turnActive/dispatch/queue as-is so public status stays working and wait
      // does not wake on the retry gap (fish 2026-08-09 experiment).
      if (event.willRetry) {
        instance.pendingErrorNotice = null; // suppress mid-retry error system messages
        logger.info("agent", "agent_end_willRetry", { member: memberName, sourceRef, memberId });
      } else {
        // Final agent_end for this attempt budget — settle deferred error notice once.
        if (instance.pendingErrorNotice) {
          if (sourceRef) schedulerServices().postSystemNotice(sourceRef, instance.pendingErrorNotice);
          instance.pendingErrorNotice = null;
        }
        // Public status may become idle here, but the SDK run can still be finalizing.
        // Keep dispatch busy until handle.prompt() settles to avoid a second prompt().
        instance.turnActive = false;
        if (!instance.promptInFlight) {
          updateDispatchState(instance, "idle", event.type);
          schedulerServices().applyPendingControls(instance, event.type);
          // Queue non-empty → continue without public idle flash (wait stays asleep).
          if (drainQueuedInputsAsPrompt(instance, event.type)) {
            (event as any)._skipIdleTransition = true;
          }
        } else {
          // prompt() still settling — if more work is queued, skip idle now; finalize
          // will drain after prompt resolves (same "queue empty" idle rule).
          if (queueDepth(instance) > 0) {
            (event as any)._skipIdleTransition = true;
          }
          if (instance.dispatchState === "idle") {
            schedulerServices().applyPendingControls(instance, event.type);
          }
        }
      }
    } else if (event.type === "compaction_start") {
      instance.compacting = true;
      transition(instance, sourceRef, memberName, "working", event.type);
    } else if (event.type === "compaction_end") {
      instance.compacting = false;
      if (!instance.turnActive) {
        transition(instance, sourceRef, memberName, "idle", event.type);
        drainQueuedInputsAsPrompt(instance, event.type);
        schedulerServices().flushPendingReload(instance);
      }
    }
    if (newStatus) {
      if (newStatus === "idle" && event.type === "agent_end" && (event as any)._skipIdleTransition) {
        // drained next prompt — stay working publicly
      } else {
        transition(instance, sourceRef, memberName, newStatus, event.type);
      }
    }

    if (event.type === "message_end" && event.stopReason === "error") {
      instance.hadErrorInTurn = true;
      const formattedError = typeof event.errorMessage === "string" ? formatRuntimeErrorMessage(event.errorMessage).trim() : "";
      instance.lastTurnError = formattedError || "unrecoverable provider error";
      const detail = formattedError
        ? ` Error: ${formattedError}`
        : " An unrecoverable provider error occurred.";
      logger.error("agent", "member request failed", { sourceRef, member: memberName, memberId, error: formattedError || "unrecoverable provider error" });
      // Defer system notice until final agent_end — willRetry attempts stay silent
      // so a retry storm posts one death notice, not one per attempt (fish 2026-08-09).
      instance.pendingErrorNotice = `Member "${memberName}" request failed.${detail}`;
    }


  });
  instance.unsubscribe = unsubscribe;
}
