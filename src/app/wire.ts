import { onCatalogChanged } from "../config/catalog.js";
import {getUserDisplayName} from "../config/settings.js";
import { refreshAllInstanceModelRegistries } from "../agent/controls.js";
import { notifyMemberProfileChanged } from "../agent/instance.js";
export function wireConfiguration(): () => void {
  return onCatalogChanged(async () => { await refreshAllInstanceModelRegistries(); });
}
import {onMemberIdentityChanged} from "../member/identity.js";
import { broadcastMemberProfileChanged } from "./ws.js";
export function wireMemberProfiles(): () => void {
  const stopRuntime = onMemberIdentityChanged(member => notifyMemberProfileChanged(member));
  const stopViews = onMemberIdentityChanged(member => broadcastMemberProfileChanged({ memberId: member.id, name: member.name, title: member.title ?? null }));
  return () => { stopRuntime(); stopViews(); };
}
import { assertMemberScopeAccess,attachmentLocation,chatScopeAssetRoots,connectConversationMembers,ensureDmScope,ensureMmScope,isMmScopeId,listRoomsForMember,parseConversation,parseMmScopeId } from "../chat/conversations.js";
import { getMember, listMembers, readMemberIdentity, resolveMemberRef,updateMember } from "../member/identity.js";
import { activeWorkspaceRoot,getActiveWorkspace,getWorkspace } from "../member/workspaces.js";
export function wireConversationMembers(): () => void { return connectConversationMembers(readMemberIdentity); }
import {createJiti} from "jiti";
import {dirname,join} from "node:path";
import {configureTerminalWorkspaces} from "../agent/terminal.js";
import {configureMcpFactoryLoader} from "../agent/runtime/resources.js";
import {createMcpOauthStorage} from "../member/mcp.js";
import * as sessionStore from "../member/sessions.js";
import {getDatabase} from "../data/database.js";
import {recoverRuntimeInputState,configureScheduler,recordMemberRuntimeEvent} from "../agent/scheduler.js";
import {listPendingReplies,dismissPendingReplies} from "../chat/delivery.js";
import {buildMemberAgentSession,maybeFlushPendingReload,loadMemberProfileSources,configureAssembly} from "../agent/assembly.js";
import type {AgentMemberSnapshot,AgentRuntime} from "../agent/types.js";
const targetOf=(sourceRef:string)=>sourceRef.startsWith("room:")?sourceRef.slice(5):sourceRef;
export function initializeMemberRuntime(runtime:AgentRuntime,loadSnapshot:(memberId:string)=>AgentMemberSnapshot|null):void{
  configureTerminalWorkspaces((memberId,workspaceId)=>(workspaceId?getWorkspace(memberId,workspaceId):getActiveWorkspace(memberId))??undefined);
  configureMcpFactoryLoader(async adapterPath=>{const loaded=await createJiti(import.meta.url).import(join(dirname(adapterPath),"host-factory.js")) as any;return {name:"pi-mcp-adapter",factory:loaded.createMcpAdapter({authStorage:createMcpOauthStorage(getDatabase())})};});
  configureControls({memberConfig:memberRecordToConfig,memberScopes:memberId=>[...listRoomsForMember(memberId).map(room=>`room:${room.id}`),...roomStore.listMmScopesForMember(memberId),`dm:${memberId}`],
    clearSession:sessionStore.clearCurrentSession,commitModelBinding:(memberId,binding)=>{updateMember(memberId,{global:binding});},emitEvent:recordMemberRuntimeEvent,
    postSystemNotice:(scopeId,text)=>{commitChatMessage(scopeId,{sender:"system",content:text,mentions:[]});},publishStatus:(scope,event)=>broadcastToRoom(targetOf(scope),event),
    publishReset:(scope,_name,event)=>scope.startsWith("dm:")?broadcastToAgentSubscribers(targetOf(scope),event):broadcastToRoom(targetOf(scope),event)});
  recoverRuntimeInputState();openRuntimeAdmission();configureAssembly(runtime,loadSnapshot,{saveSession:(memberId,runtime,session)=>sessionStore.saveCurrentSession(memberId,{runtime,...session})});
  configureScheduler({buildSession:buildMemberAgentSession,memberConfig:memberRecordToConfig,authorizeExecution:(memberId,sourceRef)=>{if(sourceRef===null)return true;if(!memberRuntimeAllowed(memberId))return false;try{assertMemberScopeAccess(memberId,sourceRef as any);return true;}catch{return false;}},
    postSystemNotice:(sourceRef,text)=>{commitChatMessage(sourceRef,{sender:"system",content:text,mentions:[]});},emitEvent:recordMemberRuntimeEvent,loadProfileSources:loadMemberProfileSources,
    applyPendingControls:applyPendingAfterPromptSettlement,interruptAccepted:(instance,sourceRef)=>interruptAcceptedInput(sourceRef,instance,"message_interrupt"),flushPendingReload:maybeFlushPendingReload,
    hasPendingReply:(db,memberId,sourceRef,replySources)=>listPendingReplies(sourceRef,memberId,db).some(reply=>replySources.includes(reply.messageId)),
    dismissReplies:(db,memberId,sourceRef,diagnosis,disposition)=>{if(sourceRef)dismissPendingReplies(sourceRef,memberId,disposition,diagnosis,Date.now(),undefined,db);}});
  repairPendingAgentAdmissions();
}
import { loadEventsPaginated, memberTokenTotal, pageActivity, readStats, setAgentEventSink, setToolActivityHook, setContextUsageRefreshHook } from "../agent/events.js";
import { abortMember,compactMember,compactMemberById,resetMemberSession,restartMember,configureControls,getAgentContextUsage,refreshAgentContextUsage,getAgentStatus,getMemberActiveTools,getMemberBusyState,applyPendingAfterPromptSettlement,interruptAcceptedInput } from "../agent/controls.js";
import { setStatusSink,openRuntimeAdmission,memberRuntimeAllowed } from "../agent/instance.js";
import { broadcastToAgentSubscribers, broadcastToRoom } from "./ws.js";
import { commitChatMessage,readMemberSystemPrompt,repairPendingAgentAdmissions,memberRecordToConfig } from "./member-actions.js";
// Knowledge activity — surfaces agent doc writes (write/edit tools) into the room chat stream.
// Connected through the agent tool-activity port; the room timeline stays the single source of
// truth ("记录自动成为沟通"). Known limit: bash-driven writes are not detected (args are opaque).
import { documentsRoot, knowledgeRoot } from "../files/layout.js";
import { displayFilename, importAttachments, inferAttachmentPreviewType, locateAttachment, type AttachmentLocation, type RoomMessageAttachment } from "../files/attachments.js";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep, relative, isAbsolute } from "node:path";
import { logger } from "../kernel/logger.js";
import * as roomStore from "../chat/conversations.js";
interface KnowledgeEventMeta {path:string;title:string;actor:string;tool:"write"|"edit";outsideRoomDocsPath?:boolean;}
function docsRoot(): string {
  return resolve(documentsRoot());
}
/** Dedup window: the same agent touching the same doc repeatedly (multi-edit
 *  sessions) should produce one card, not a stream of them. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentCards = new Map<string, number>(); // `${roomId}:${actor}:${relPath}` -> ts
function shouldEmit(key: string): boolean {
  const now = Date.now();
  const last = recentCards.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  recentCards.set(key, now);
  // Opportunistic cleanup
  if (recentCards.size > 500) {
    for (const [k, ts] of recentCards) {
      if (now - ts >= DEDUP_WINDOW_MS) recentCards.delete(k);
    }
  }
  return true;
}
/** Extract a display title: first markdown heading > filename. Frontmatter is plain content. */
function extractTitle(absPath: string, relPath: string): string {
  try {
    const raw = readFileSync(absPath, "utf-8").slice(0, 4000);
    const headingMatch = raw.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();
  } catch {
    /* file may have been deleted right after */
  }
  const base = relPath.split("/").pop() || relPath;
  return base.replace(/\.[^.]+$/i, "").replace(/[-_]/g, " ");
}
/**
 * Inspect a finished tool call; if it wrote into the knowledge docs tree,
 * post a knowledge_event card into the room.
 */
export function maybeEmitKnowledgeActivity(
  roomId: string,
  memberId:string,
  toolName: string,
  args: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName !== "write" && toolName !== "edit") return;
  const rawPath = (args as any)?.path ?? (args as any)?.file_path;
  if (typeof rawPath !== "string" || !rawPath) return;
  const room=roomStore.getRoom(roomId),agentName=readMemberIdentity(memberId)?.name??memberId;
  const root = docsRoot();
  const abs=isAbsolute(rawPath)?resolve(rawPath):resolve(activeWorkspaceRoot(memberId),rawPath);
  if (abs !== root && !abs.startsWith(root + sep)) return;
  const relPath = relative(root, abs).split(sep).join("/");
  const key = `${roomId}:${agentName}:${relPath}`;
  if (!shouldEmit(key)) return;

  const title = extractTitle(abs, relPath);
  const verb = existsSync(abs) && toolName === "write" ? "更新了文档" : toolName === "edit" ? "修改了文档" : "写入了文档";
  const docsPath = room?.docsPath;
  const outsideRoomDocsPath = !!docsPath && !relPath.startsWith(docsPath);
  const meta: KnowledgeEventMeta = { path: relPath, title, actor: agentName, tool: toolName as "write" | "edit", ...(outsideRoomDocsPath ? { outsideRoomDocsPath: true } : {}) };

  try {
    commitChatMessage(`room:${roomId}`, {
      sender: "system", content: `[Knowledge] ${agentName} ${verb}: **${title}**`, mentions: [],
      type: "knowledge_event", knowledge_event_meta: meta as unknown as Record<string, unknown>,
    });
    logger.info("knowledge-activity", "card emitted", { roomId, agent: agentName, path: relPath });
  } catch (err) {
    logger.error("knowledge-activity", "emit failed", { roomId, error: String(err) });
  }
}

/** Connect agent event facts to transports and chat ownership; the agent core stays subscriber-free. */
import { connectChatHttpActions } from "../api/chats.js";
import { connectMemberHttpActions } from "../api/members.js";

/** Register HTTP route modules once during application startup, never per request. */
export async function wireApiRoutes(): Promise<void> {
  await Promise.all([
    import("../api/members.js"), import("../api/chats.js"), import("../api/models.js"),
    import("../api/workspaces.js"), import("../api/files.js"), import("../api/knowledge.js"),
    import("../api/usage.js"),
  ]);
}
import { configureAgentToolHost,renderQueryRowsForMember,type QueryRow } from "../agent/tools.js";
import { queryMessages,searchMessages,setMessageSink,type MemberMessageView,type MessageSearchHit } from "../chat/messages.js";
import {confirmMemberCursor} from "../chat/cursors.js";
import {writeTemporaryText} from "../files/io.js";
import { parseMentions } from "../chat/delivery.js";
import { updateProfileForMember } from "../member/profile.js";
import { createWorkspace, readWorkspaces, removeWorkspace, useWorkspace } from "../member/workspaces.js";

export function wireMemberHttp(): () => void {
  return connectMemberHttpActions({
    readCurrentPrompt: readMemberSystemPrompt,
    readStats,
    readTokenTotal: memberTokenTotal,
    readActivity: pageActivity,
    stop: abortMember,
    compact: compactMemberById,
    reset: resetMemberSession,
    restart: restartMember,
  });
}

function resolveToolChat(memberId:string,current:string|null,value:unknown):string{
  const ref=String(value??"").trim();
  if(!ref){if(!current)throw new Error("This tool call needs a current chat or an explicit target");return current;}
  if(ref==="user"||ref==="dm"||ref===memberId)return `dm:${memberId}`;
  if(ref.startsWith("room:")||ref.startsWith("dm:")||isMmScopeId(ref)){assertMemberScopeAccess(memberId,ref);return ref;}
  const direct=roomStore.getRoom(ref);
  if(direct&&roomStore.resolveRoomMember(ref,memberId))return `room:${ref}`;
  const named=listRoomsForMember(memberId).filter(room=>room.name.toLowerCase()===ref.toLowerCase());
  if(named.length===1)return `room:${named[0].id}`;
  if(named.length>1)throw new Error(`Multiple chats named "${ref}"; use the chat id`);
  const peer=resolveMemberRef(ref);
  if(peer){if(peer.id===memberId)return `dm:${memberId}`;return ensureMmScope(memberId,peer.id);}
  throw new Error(`Chat not found: ${ref}`);
}
function toolLimit(value:unknown):number{
  if(value===undefined)return 50;const parsed=Number(value);if(!Number.isFinite(parsed))throw new Error("limit must be a finite number");return Math.max(1,Math.min(Math.floor(parsed),500));
}
function toolTime(value:unknown):number|undefined{
  const raw=String(value??"").trim();if(!raw)return undefined;const normalized=raw.toLowerCase(),now=Date.now();
  if(normalized==="today"){const date=new Date(now);return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate());}
  if(normalized==="yesterday"){const date=new Date(now);return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate())-86_400_000;}
  const relative=/^(\d+)([mhd])$/.exec(normalized);if(relative){const amount=Number(relative[1]),unit=relative[2]==="m"?60_000:relative[2]==="h"?3_600_000:86_400_000;return now-amount*unit;}
  const parsed=Date.parse(raw);if(!Number.isFinite(parsed))throw new Error(`Invalid chat time: ${raw}`);return parsed;
}
function memberQueryRows(sourceRef:string,messages:MemberMessageView[]):QueryRow[]{
  const ref=parseConversation(sourceRef);if(!ref)throw new Error(`Invalid conversation: ${sourceRef}`);const location=attachmentLocation(ref);
  return messages.map(message=>({seq:message.seq,sender:message.sender,content:message.content,ts:message.ts,replyTo:message.replyTo,
    attachments:message.attachments?.map(attachment=>{const located=locateAttachment(location,attachment.storedFilename);return {originalFilename:attachment.originalFilename,...(located.ok?{path:located.path}:{unavailable:true})};})}));
}
function searchQueryRows(messages:MessageSearchHit[]):QueryRow[]{
  return messages.map(message=>({seq:message.seq,sender:message.sender,content:message.content,ts:message.ts}));
}
function advanceToolReadCursor(memberId:string,currentSourceRef:string|null,target:string,messages:Array<{id:string;seq?:number}>):void{
  if(target!==currentSourceRef||target.startsWith("dm:")||messages.length===0)return;
  const furthest=messages.reduce((best,message)=>(message.seq??0)>(best.seq??0)?message:best);
  confirmMemberCursor({scopeId:target,memberId,messageId:furthest.id,messageSeq:furthest.seq??null});
}
function writeChatQueryFile(sourceRef:string,rows:QueryRow[]):string{
  return writeTemporaryText(renderQueryRowsForMember(rows),`bossmode-chat-read-${sourceRef}`,".md");
}

async function executeAgentHostTool(input:{tool:string;params:Record<string,unknown>;memberId:string;currentSourceRef:string|null}):Promise<unknown>{
  const {tool,params,memberId,currentSourceRef}=input;
  const member=getMember(memberId);if(!member)return {ok:false,error:"Member not found",code:"not_found"};
  if(tool==="profile_read")return {ok:true,member:{id:member.id,name:member.name,description:member.title??""}};
  if(tool==="profile_update"){
    try{const result=updateProfileForMember(memberId,{name:params.name,title:params.description});return {ok:true,member:{id:result.memberId,name:result.name,description:result.title??""},changed:result.changed};}
    catch(error){return {ok:false,error:(error as Error).message};}
  }
  if(tool==="chat_send"){
    const target=resolveToolChat(memberId,currentSourceRef,params.to),message=String(params.message??"");
    if(target.startsWith("dm:"))ensureDmScope(target.slice(3));
    const paths=Array.isArray(params.attachments)?params.attachments.map(String):[];
    if(!message.trim()&&!paths.length)return {ok:false,error:"message must be a non-empty string"};
    const roomId=target.startsWith("room:")?target.slice(5):null;
    const mentions=roomId?parseMentions(message,roomStore.getRoomMembers(roomId)): {labels:[],memberIds:[]};
    const attachments:RoomMessageAttachment[]=[];
    if(paths.length){
      const pair=parseMmScopeId(target);
      const location:AttachmentLocation=roomId?{kind:"room",roomId}:pair?{kind:"mm",memberIds:pair}:{kind:"dm",memberId:target.slice(3)};
      const outcomes=await importAttachments(paths,location,[...chatScopeAssetRoots(target),tmpdir(),knowledgeRoot()]);
      const errors=outcomes.filter(result=>!result.ok);if(errors.length)return {ok:false,error:`Attachment failed: ${errors.map(result=>`${result.path}: ${result.error}`).join("; ")}`};
      for(const stored of outcomes)if(stored.ok){const originalFilename=displayFilename(stored.originalFilename);attachments.push({id:stored.storedFilename,storedFilename:stored.storedFilename,originalFilename,size:stored.size,previewType:inferAttachmentPreviewType(stored.storedFilename||originalFilename)});}
    }
    const saved=commitChatMessage(target,{sender:member.name,senderMemberId:memberId,content:message,mentions:mentions.labels,mentionMemberIds:mentions.memberIds,attachments});
    const pair=parseMmScopeId(target);
    if(pair&&saved.seq===1){
      const other=pair.find(id=>id!==memberId)!;const otherName=getMember(other)?.name??other;ensureDmScope(other);
      commitChatMessage(`dm:${other}`,{sender:"system",content:`Members ${member.name} and ${otherName} started a private chat. Open it to read (read-only).`,mentions:[],member_chat_meta:{scopeId:target,fromMemberId:memberId,toMemberId:other}});
    }
    return {ok:true,messageId:saved.id,sourceRef:target};
  }
  if(tool==="chat_read"){
    const output=String(params.output??"text");if(output!=="text"&&output!=="file")throw new Error('output must be "text" or "file"');
    const target=resolveToolChat(memberId,currentSourceRef,params.chat),messages=queryMessages(target,{limit:toolLimit(params.limit),
      fromSeq:params.from_seq===undefined?undefined:Number(params.from_seq),aroundSeq:params.around_seq===undefined?undefined:Number(params.around_seq),beforeTs:toolTime(params.before),afterTs:toolTime(params.after)}),rows=memberQueryRows(target,messages);
    advanceToolReadCursor(memberId,currentSourceRef,target,messages);
    return output==="file"?{ok:true,chat:target,path:writeChatQueryFile(target,rows),count:rows.length}:{ok:true,chat:target,messages:rows};
  }
  if(tool==="chat_search"){
    const query=String(params.query??"");if(!query.trim())return {ok:false,error:"query is required — provide the text to search for"};
    const target=resolveToolChat(memberId,currentSourceRef,params.chat),result=searchMessages(target,{query,from:params.from?String(params.from):undefined,
      after:toolTime(params.after),before:toolTime(params.before),limit:toolLimit(params.limit)});
    advanceToolReadCursor(memberId,currentSourceRef,target,result.messages);
    return {ok:true,chat:target,total:result.total,messages:searchQueryRows(result.messages)};
  }
  if(tool==="chat_list"){
    const rooms=listRoomsForMember(memberId).map(room=>({kind:"room",id:`room:${room.id}`,name:room.name,description:room.description??""}));
    const mm=roomStore.listMmScopesForMember(memberId).map(id=>{const peer=parseMmScopeId(id)?.find(value=>value!==memberId),name=peer?(getMember(peer)?.name??peer):"member";return {kind:"mm",id,name:`Private chat with ${name}`,description:""};});
    const chats=[{kind:"dm",id:`dm:${memberId}`,name:"user",description:"Private chat with the user"},...rooms,...mm];
    const query=String(params.query??"").toLowerCase(),filtered=query?chats.filter(chat=>`${chat.id} ${chat.name} ${chat.description}`.toLowerCase().includes(query)):chats;
    const offset=Math.max(0,Number(params.offset)||0),limit=Math.max(1,Math.min(Number(params.limit)||50,500));return {ok:true,chats:filtered.slice(offset,offset+limit),total:filtered.length};
  }
  if(tool==="chat_info"){
    const target=resolveToolChat(memberId,currentSourceRef,params.chat),pair=parseMmScopeId(target);
    if(target.startsWith("dm:"))return {ok:true,chat:{id:target,kind:"dm",name:"user"}};
    if(pair){const peer=pair.find(id=>id!==memberId)!;return {ok:true,chat:{id:target,kind:"mm",name:`Private chat with ${getMember(peer)?.name??peer}`,counterpart:peer}};}
    const room=roomStore.getRoom(target.slice(5))!;return {ok:true,chat:{id:target,kind:"room",name:room.name,description:room.description??"",members:roomStore.getRoomMembers(room.id).map(item=>({id:item.id,name:item.name}))}};
  }
  if(tool==="chat_create"){
    const name=String(params.name??"").trim();if(!name)return {ok:false,error:"name is required"};
    const ids=[...new Set([memberId,...(Array.isArray(params.members)?params.members.map(String):[])])];const missing=ids.filter(id=>!getMember(id));if(missing.length)return {ok:false,error:`Unknown member id: ${missing.join(", ")}`};
    try{const room=roomStore.createRoom(name,ids,{promptLeaderMemberId:memberId,description:String(params.description??"").trim()});return {ok:true,chat:{id:`room:${room.id}`,kind:"room",name:room.name}};}catch(error){return {ok:false,error:(error as Error).message};}
  }
  if(tool==="chat_edit"){
    const target=resolveToolChat(memberId,currentSourceRef,params.chat);if(!target.startsWith("room:"))return {ok:false,error:"chat_edit edits group chats only"};const roomId=target.slice(5);
    const patch:{name?:string;description?:string}={};if(typeof params.name==="string"&&params.name.trim())patch.name=params.name.trim();if(typeof params.description==="string")patch.description=params.description.trim();if(Object.keys(patch).length)roomStore.updateRoom(roomId,patch);
    const added:string[]=[],removed:string[]=[];for(const id of Array.isArray(params.add_members)?params.add_members.map(String):[]){const item=getMember(id);if(item&&roomStore.inviteRoomMember(roomId,item.id).ok)added.push(item.name);}
    for(const id of Array.isArray(params.remove_members)?params.remove_members.map(String):[]){if(id===memberId)continue;const item=getMember(id);if(item&&roomStore.removeRoomMember(roomId,item.id).ok)removed.push(item.name);}
    const room=roomStore.getRoom(roomId)!;return {ok:true,chat:{id:target,kind:"room",name:room.name},added,removed};
  }
  if(tool==="member_list"){
    const query=String(params.query??"").toLowerCase();let members=listMembers().map(item=>({id:item.id,name:item.name,description:item.title??""}));if(query)members=members.filter(item=>`${item.id} ${item.name} ${item.description}`.toLowerCase().includes(query));const offset=Math.max(0,Number(params.offset)||0),limit=Math.max(1,Math.min(Number(params.limit)||50,500));return {ok:true,members:members.slice(offset,offset+limit),total:members.length};
  }
  if(tool==="member_info"){const target=resolveMemberRef(String(params.member??""));return target?{ok:true,member:{id:target.id,name:target.name,description:target.title??"",status:getAgentStatus(target.id)}}:{ok:false,error:"Member not found"};}
  if(tool==="workspace_list")return {ok:true,...readWorkspaces(memberId)};
  if(tool==="workspace_create")return createWorkspace(memberId,params as any);
  if(tool==="workspace_use")return useWorkspace(memberId,String(params.id??""));
  if(tool==="workspace_remove")return removeWorkspace(memberId,String(params.id??""));
  return {ok:false,error:`Unsupported tool: ${tool}`};
}

function getScopeLiveStatus(scopeId:string):"idle"|"working"|"inactive"{
  const ref=parseConversation(scopeId);if(!ref)return "inactive";
  if(ref.kind==="dm")return getAgentStatus(ref.memberId);
  const memberIds=ref.kind==="mm"?ref.memberIds:roomStore.getRoomMembers(ref.roomId).map(member=>member.id);
  const statuses=memberIds.map(getAgentStatus);return statuses.includes("working")?"working":statuses.some(status=>status!=="inactive")?"idle":"inactive";
}
const getRoomAgentStatuses=(roomId:string)=>Object.fromEntries(roomStore.getRoomMembers(roomId).map(member=>[member.name,getAgentStatus(member.id)]));

export function wireChatHttp(): () => void {
  setMessageSink((sourceRef, message) => {
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToRoom(target, { type: "room:message", roomId: target, message: message as any });
  });
  const disconnectHttp = connectChatHttpActions({
    readUserLogin:getUserDisplayName,
    postMessage: commitChatMessage,
    resetSession: (_sourceRef, memberId) => resetMemberSession(memberId),
    abort: (_sourceRef, memberId) => abortMember(memberId),
    compact: compactMember,
    readContextUsage: (_sourceRef, memberId) => getAgentContextUsage(memberId),
    readEvents: (sourceRef, memberId, limit, before) => loadEventsPaginated(sourceRef, memberId, limit, before),
    readTools: (_sourceRef, memberId) => getMemberActiveTools(memberId),
    readSession: (_sourceRef, memberId) => ({
      status: getAgentStatus(memberId),
      busy: getMemberBusyState(memberId),
      contextUsage: getAgentContextUsage(memberId),
    }),
    scopeStatus: sourceRef => getScopeLiveStatus(sourceRef),
    roomStatuses: roomId => getRoomAgentStatuses(roomId),
  });
  configureAgentToolHost(executeAgentHostTool);
  return () => { setMessageSink(undefined); configureAgentToolHost(undefined); disconnectHttp(); };
}

function refreshContextUsage(roomId:string,memberId:string):void{
  const name=getMember(memberId)?.name??memberId;
  void refreshAgentContextUsage(memberId).then(usage=>{if(usage)broadcastToRoom(roomId,{type:"agent:context_usage",roomId,agent:name,memberId,usage});}).catch(()=>{});
}

export function wireAgentEvents(): () => void {
  setAgentEventSink((sourceRef, memberId, payload) => {
    const agentName = readMemberIdentity(memberId)?.name ?? memberId;
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToAgentSubscribers(target, { ...payload, roomId: target, agent: agentName, memberId });
  });
  setStatusSink((sourceRef, payload) => {
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToRoom(target, { ...payload, roomId: target });
  });
  setToolActivityHook(({ sourceRef, memberId, toolName, args, isError }) => {
    if (!sourceRef.startsWith("room:")) return;
    maybeEmitKnowledgeActivity(sourceRef.slice(5),memberId,toolName,args,isError);
  });
  setContextUsageRefreshHook((sourceRef, memberId) => {
    if (sourceRef) refreshContextUsage(sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef, memberId);
  });
  return () => { setAgentEventSink(undefined); setStatusSink(undefined); setToolActivityHook(undefined); setContextUsageRefreshHook(undefined); };
}
