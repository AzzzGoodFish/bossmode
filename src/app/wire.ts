import { onCatalogChanged } from "../config/catalog.js";
import { refreshAllInstanceModelRegistries } from "../agent/controls.js";
import { notifyMemberProfileChanged } from "../agent/instance.js";

/** Configuration reports changes; only the composition root connects them to execution. */
export function wireConfiguration(): () => void {
  return onCatalogChanged(async () => { await refreshAllInstanceModelRegistries(); });
}

import { onMemberProfileChanged } from "../member/profile.js";
import { setGlobalConfigPatchObserver } from "../member/identity.js";
import { markStaleMounts } from "../agent/instance.js";
import { broadcastMemberProfileChanged } from "./ws.js";

export function wireMemberProfiles(): () => void {
  const stopRuntime = onMemberProfileChanged(member => notifyMemberProfileChanged(member));
  const stopViews = onMemberProfileChanged(member => broadcastMemberProfileChanged({ memberId: member.id, name: member.name, title: member.title ?? null }));
  return () => { stopRuntime(); stopViews(); };
}

/** Stale-mount bookkeeping rides the config-patch transaction (failure rolls back together). */
export function wireMemberConfigPatches(): () => void {
  setGlobalConfigPatchObserver((id, fields) => markStaleMounts(id, fields));
  return () => setGlobalConfigPatchObserver(undefined);
}

import { assertMemberScopeAccess, chatScopeAssetRoots, connectConversationMembers, ensureMmScope, isMmScopeId, listRoomsForMember, parseMmScopeId } from "../chat/conversations.js";
import { getMember, listMembers, readMemberIdentity, resolveMemberRef } from "../member/identity.js";
export function wireConversationMembers(): () => void {
  return connectConversationMembers(readMemberIdentity);
}

import { loadEventsPaginated, memberTokenTotal, pageActivity, readStats, readUsageRows, setAgentEventSink, setToolActivityHook, setContextUsageRefreshHook } from "../agent/events.js";
import { abortMember, compactMember, compactMemberById, resetMemberSession, restartMember } from "../agent/controls.js";
import { setStatusSink } from "../agent/instance.js";
import { broadcastToAgentSubscribers, broadcastToRoom } from "./ws.js";
import { commitChatMessage, getAgentContextUsage, getAgentStatus, getMemberActiveTools, getMemberBusyState, getRoomAgentStatuses, getScopeLiveStatus, previewMemberPrompt, refreshContextUsage, setRuntimeViewSink } from "./member-actions.js";

// Knowledge activity — surfaces agent doc writes (write/edit tools) into the room chat stream.
// Connected through the agent tool-activity port; the room timeline stays the single source of
// truth ("记录自动成为沟通"). Known limit: bash-driven writes are not detected (args are opaque).
import { documentsRoot, knowledgeRoot } from "../files/layout.js";
import { displayFilename, importAttachments, inferAttachmentPreviewType, type AttachmentLocation, type RoomMessageAttachment } from "../files/attachments.js";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep, relative, isAbsolute } from "node:path";

import { logger } from "../kernel/logger.js";
import * as roomStore from "../chat/conversations.js";
import type { KnowledgeEventMeta } from "../kernel/types.js";

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
  agentName: string,
  toolName: string,
  args: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName !== "write" && toolName !== "edit") return;

  const rawPath = (args as any)?.path ?? (args as any)?.file_path;
  if (typeof rawPath !== "string" || !rawPath) return;

  const room = roomStore.getRoom(roomId);
  const root = docsRoot();
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(room?.cwd || process.cwd(), rawPath);
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
import { connectUsageHttpQueries } from "../api/usage.js";

/** Register HTTP route modules once during application startup, never per request. */
export async function wireApiRoutes(): Promise<void> {
  await Promise.all([
    import("../api/members.js"), import("../api/chats.js"), import("../api/models.js"),
    import("../api/workspaces.js"), import("../api/files.js"), import("../api/knowledge.js"),
    import("../api/usage.js"),
  ]);
}
import { configureAgentToolHost } from "../agent/tools.js";
import { pageMessages, searchMessages, setMessageSink } from "../chat/messages.js";
import { parseMentions } from "../chat/delivery.js";
import { updateProfileForMember } from "../member/profile.js";
import { createWorkspace, readWorkspaces, removeWorkspace, useWorkspace } from "../member/workspaces.js";

export function wireMemberHttp(): () => void {
  return connectMemberHttpActions({
    previewPrompt: memberId => {
      const prompt = previewMemberPrompt(memberId);
      return { text: prompt.fullPrompt, contractFingerprint: prompt.contractFingerprint };
    },
    readStats,
    readTokenTotal: memberTokenTotal,
    readActivity: pageActivity,
    stop: abortMember,
    compact: compactMemberById,
    reset: resetMemberSession,
    restart: restartMember,
  });
}

export function wireUsageHttp(): () => void {
  return connectUsageHttpQueries({ readUsageRows });
}

function resolveToolChat(memberId:string,current:string|null,value:unknown):string{
  const ref=String(value??"").trim();
  if(!ref){if(!current)throw new Error("This tool call needs a current chat or an explicit target");return current;}
  if(ref==="user"||ref==="dm"||ref===memberId)return `dm:${memberId}`;
  if(ref.startsWith("room:")||ref.startsWith("dm:")||isMmScopeId(ref)){assertMemberScopeAccess(memberId,ref);return ref;}
  const direct=roomStore.getRoom(ref);
  if(direct&&roomStore.resolveRoomMemberRef(ref,memberId))return `room:${ref}`;
  const named=listRoomsForMember(memberId).filter(room=>room.name.toLowerCase()===ref.toLowerCase());
  if(named.length===1)return `room:${named[0].id}`;
  if(named.length>1)throw new Error(`Multiple chats named "${ref}"; use the chat id`);
  const peer=resolveMemberRef(ref);
  if(peer){if(peer.id===memberId)return `dm:${memberId}`;return ensureMmScope(memberId,peer.id);}
  throw new Error(`Chat not found: ${ref}`);
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
    return {ok:true,messageId:saved.id,sourceRef:target};
  }
  if(tool==="chat_read"){
    const target=resolveToolChat(memberId,currentSourceRef,params.chat);
    return {ok:true,chat:target,messages:pageMessages(target,{limit:Number(params.limit)||50,fromSeq:params.from_seq===undefined?undefined:Number(params.from_seq),before:params.before?String(params.before):undefined,around:params.around_seq?String(params.around_seq):undefined})};
  }
  if(tool==="chat_search"){
    const target=resolveToolChat(memberId,currentSourceRef,params.chat);
    const after=params.after?Date.parse(String(params.after)):undefined,before=params.before?Date.parse(String(params.before)):undefined;
    return {ok:true,chat:target,...searchMessages(target,{query:String(params.query??""),from:params.from?String(params.from):undefined,after:Number.isFinite(after)?after:undefined,before:Number.isFinite(before)?before:undefined,limit:Number(params.limit)||50})};
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
    try{const room=roomStore.createRoom(name,undefined,ids,undefined,{promptLeaderMemberId:memberId,description:String(params.description??"").trim()});return {ok:true,chat:{id:`room:${room.id}`,kind:"room",name:room.name}};}catch(error){return {ok:false,error:(error as Error).message};}
  }
  if(tool==="chat_edit"){
    const target=resolveToolChat(memberId,currentSourceRef,params.chat);if(!target.startsWith("room:"))return {ok:false,error:"chat_edit edits group chats only"};const roomId=target.slice(5);
    if(typeof params.name==="string"&&params.name.trim())roomStore.updateRoomName(roomId,params.name.trim());if(typeof params.description==="string")roomStore.updateRoomDescription(roomId,params.description.trim());
    const added:string[]=[],removed:string[]=[];for(const id of Array.isArray(params.add_members)?params.add_members.map(String):[]){const item=getMember(id);if(item&&roomStore.inviteGlobalMember(roomId,{id:item.id,name:item.name,agentTemplate:item.agentTemplate||"general"}).ok)added.push(item.name);}
    for(const id of Array.isArray(params.remove_members)?params.remove_members.map(String):[]){if(id===memberId)continue;const item=getMember(id);if(item&&roomStore.removeRoomMemberByRef(roomId,item.name,{globalMemberId:item.id}).ok)removed.push(item.name);}
    const room=roomStore.getRoom(roomId)!;return {ok:true,chat:{id:target,kind:"room",name:room.name},added,removed};
  }
  if(tool==="member_list"){
    const query=String(params.query??"").toLowerCase();let members=listMembers().map(item=>({id:item.id,name:item.name,description:item.title??""}));if(query)members=members.filter(item=>`${item.id} ${item.name} ${item.description}`.toLowerCase().includes(query));const offset=Math.max(0,Number(params.offset)||0),limit=Math.max(1,Math.min(Number(params.limit)||50,500));return {ok:true,members:members.slice(offset,offset+limit),total:members.length};
  }
  if(tool==="member_info"){const target=resolveMemberRef(String(params.member??""));return target?{ok:true,member:{id:target.id,name:target.name,description:target.title??""}}:{ok:false,error:"Member not found"};}
  if(tool==="workspace_list")return {ok:true,...readWorkspaces(memberId)};
  if(tool==="workspace_create")return createWorkspace(memberId,params as any);
  if(tool==="workspace_use")return useWorkspace(memberId,String(params.id??""));
  if(tool==="workspace_remove")return removeWorkspace(memberId,String(params.id??""));
  return {ok:false,error:`Unsupported tool: ${tool}`};
}

export function wireChatHttp(): () => void {
  setMessageSink((sourceRef, message) => {
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToRoom(target, { type: "room:message", roomId: target, message: message as any });
  });
  const disconnectHttp = connectChatHttpActions({
    postMessage: commitChatMessage,
    resetSession: (_sourceRef, memberId) => resetMemberSession(memberId),
    abort: (_sourceRef, memberId) => abortMember(memberId),
    compact: compactMember,
    readContextUsage: (sourceRef, memberId) => getAgentContextUsage(sourceRef, memberId),
    readEvents: (sourceRef, memberId, limit, before) => loadEventsPaginated(sourceRef, memberId, limit, before),
    readTools: (sourceRef, memberId) => getMemberActiveTools(sourceRef, memberId),
    readSession: (sourceRef, memberId) => ({
      status: getAgentStatus(sourceRef, memberId),
      busy: getMemberBusyState(sourceRef, memberId),
      contextUsage: getAgentContextUsage(sourceRef, memberId),
    }),
    scopeStatus: sourceRef => getScopeLiveStatus(sourceRef),
    roomStatuses: roomId => getRoomAgentStatuses(roomId),
  });
  configureAgentToolHost(executeAgentHostTool);
  return () => { setMessageSink(undefined); configureAgentToolHost(undefined); disconnectHttp(); };
}

export function wireAgentEvents(): () => void {
  setRuntimeViewSink((scopeId, event, memberName) => {
    if (memberName === undefined) broadcastToRoom(scopeId, event);
    else broadcastToAgentSubscribers(scopeId, memberName, event);
  });
  setAgentEventSink((sourceRef, memberId, payload) => {
    const agentName = readMemberIdentity(memberId)?.name ?? memberId;
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToAgentSubscribers(target, agentName, { ...payload, roomId: target, agent: agentName });
  });
  setStatusSink((sourceRef, payload) => {
    const target = sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
    broadcastToRoom(target, { ...payload, roomId: target });
  });
  setToolActivityHook(({ sourceRef, memberId, toolName, args, isError }) => {
    if (!sourceRef.startsWith("room:")) return;
    maybeEmitKnowledgeActivity(sourceRef.slice(5), readMemberIdentity(memberId)?.name ?? memberId, toolName, args, isError);
  });
  setContextUsageRefreshHook((sourceRef, memberId, options) => {
    if (sourceRef) refreshContextUsage(sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef, memberId, options);
  });
  return () => { setRuntimeViewSink(undefined); setAgentEventSink(undefined); setStatusSink(undefined); setToolActivityHook(undefined); setContextUsageRefreshHook(undefined); };
}
