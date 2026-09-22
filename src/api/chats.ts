import {chatPinnedAt,setChatPinned} from "../chat/preferences.js";
import {
  attachmentLocation,
  createRoom,
  getRoom,
  getRoomMembers,
  inviteRoomMember,
  isMemberId,
  listRooms,
  parseConversation,
  removeRoomMember,
  resolveConversation,
  resolveRoomMember,
  updateRoom,
  RoomWriteError,
  type Room,
} from "../chat/conversations.js";
import { setUserReadCursor } from "../chat/cursors.js";
import { parseMentions } from "../chat/delivery.js";
import {
  pageMessages,
  readConversationListState,
  searchMessages,
  type Message,
  type MessageInput,
} from "../chat/messages.js";
import { attachmentExists, displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../files/attachments.js";
import { getMember, listMembers } from "../member/identity.js";
import { addRoute, HttpError, parseBody, requestUrl, requestValue, sendJson, type RouteHandler } from "./http.js";

export interface ChatHttpActions {
  deleteRoom?(roomId:string):Promise<boolean>;
  postMessage(sourceRef: string, input: MessageInput): Promise<Message> | Message;
  resetSession(sourceRef: string, memberId: string): Promise<unknown> | unknown;
  abort(sourceRef: string, memberId: string): Promise<unknown> | unknown;
  compact(sourceRef: string, memberId: string): Promise<unknown> | unknown;
  readContextUsage(sourceRef: string, memberId: string): unknown;
  readEvents(sourceRef: string, memberId: string, limit: number, before?: number): unknown;
  readTools(sourceRef: string, memberId: string): unknown;
  readSession(sourceRef: string, memberId: string): unknown;
  scopeStatus?(sourceRef: string): string;
  roomStatuses?(roomId: string): unknown;
  readUserLogin(): string;
}
let actions: ChatHttpActions | undefined;
export function connectChatHttpActions(next: ChatHttpActions): () => void {
  actions = next;
  return () => { if (actions === next) actions = undefined; };
}
function connected(): ChatHttpActions {
  if (!actions) throw new Error("Chat HTTP actions are not connected");
  return actions;
}

function chatSummary(sourceRef: string, kind: "room" | "dm", title: string) {
  const state = readConversationListState(sourceRef, actions?.readUserLogin() ?? "");
  const status = actions?.scopeStatus?.(sourceRef) ?? "idle";
  const pinnedAt=chatPinnedAt(sourceRef);
  return {
    scopeId: sourceRef,
    ...(pinnedAt!==null?{pinnedAt}:{}),
    kind,
    title,
    ...state,
    status: status === "inactive" ? "idle" : status,
  };
}

addRoute("GET", "/api/chats", async (_request, response) => {
  const chats = [
      ...listMembers().map((member) => chatSummary(`dm:${member.id}`, "dm" as const, member.name)),
      ...listRooms().map((room) => chatSummary(`room:${room.id}`, "room" as const, room.name)),
  ].sort((a, b) => (b.pinnedAt??0)-(a.pinnedAt??0)||(b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
  sendJson(response, 200, { chats });
});

addRoute("POST", "/api/conversations/:scope/read", async (request, response, params) => {
  const sourceRef = conversationSource(params.scope);
  if (!sourceRef) throw new HttpError(404, "conversation_not_found", "Conversation not found");
  const body = await parseBody(request) as { messageId?: string | null; seq?: number | null };
  const last = body.messageId === undefined && body.seq === undefined ? pageMessages(sourceRef, { limit: 1 }).at(-1) : undefined;
  const cursor = setUserReadCursor(sourceRef, {
    messageId: body.messageId === undefined ? last?.id ?? null : body.messageId,
    seq: body.seq === undefined ? last?.seq ?? null : body.seq,
  });
  sendJson(response, 200, { scopeId: sourceRef, cursor });
});

interface ConversationTarget { sourceRef: string; memberId: string; memberName: string }
function conversationTarget(sourceRef: string, request: { url?: string }): ConversationTarget | null {
  const ref = resolveConversation(sourceRef);
  if (!ref) return null;
  if (ref.kind === "dm") {
    const member = getMember(ref.memberId);
    return member ? { sourceRef: ref.scopeId, memberId: member.id, memberName: member.name } : null;
  }
  const memberId = requestUrl(request).searchParams.get("memberId") || "";
  if (!memberId) return null;
  if (ref.kind === "room") {
    const member = resolveRoomMember(ref.roomId, memberId);
    return member ? { sourceRef: ref.scopeId, memberId: member.id, memberName: member.name } : null;
  }
  const member = getMember(memberId);
  return member && ref.memberIds.includes(member.id) ? { sourceRef: ref.scopeId, memberId: member.id, memberName: member.name } : null;
}
type TargetHandler = (request: Parameters<RouteHandler>[0], response: Parameters<RouteHandler>[1], target: ConversationTarget) => Promise<void>;
function addTargetRoute(method: string, path: string, handler: TargetHandler): void {
  addRoute(method, path, async (request, response, params) => {
    const target = conversationTarget(params.scope, request);
    if (!target) throw new HttpError(400, "scope_or_member_not_found", "Conversation or member not found");
    await handler(request, response, target);
  });
}

for (const [path, action] of [["reset-session", "resetSession"], ["abort", "abort"]] as const) {
  addTargetRoute("POST", `/api/conversations/:scope/${path}`, async (_request, response, target) => {
    sendJson(response, 200, { ...await connected()[action](target.sourceRef, target.memberId) as object, scopeId: target.sourceRef });
  });
}
addTargetRoute("POST", "/api/conversations/:scope/compact", async (_request, response, target) => {
  const result = await requestValue(() => connected().compact(target.sourceRef, target.memberId), 400, "compact_failed");
  sendJson(response, 200, { ...result as object, scopeId: target.sourceRef });
});
addTargetRoute("GET", "/api/conversations/:scope/context-usage", async (_request, response, target) => {
  const usage = connected().readContextUsage(target.sourceRef, target.memberId);
  sendJson(response, 200, usage === null ? { supported: true, unavailable: true, scopeId: target.sourceRef }
    : { supported: true, scopeId: target.sourceRef, ...usage as object });
});
addTargetRoute("GET", "/api/conversations/:scope/events", async (request, response, target) => {
  const url = requestUrl(request);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 200));
  const rawBefore = url.searchParams.get("before");
  const before = rawBefore === null ? undefined : Number(rawBefore);
  const page = connected().readEvents(target.sourceRef, target.memberId, limit, Number.isFinite(before) ? before : undefined);
  sendJson(response, 200, { ...page as object, scopeId: target.sourceRef, memberId: target.memberId });
});
addTargetRoute("GET", "/api/conversations/:scope/tools", async (_request, response, target) => {
  sendJson(response, 200, { ...connected().readTools(target.sourceRef, target.memberId) as object, scopeId: target.sourceRef, memberId: target.memberId });
});
addTargetRoute("GET", "/api/conversations/:scope/session", async (_request, response, target) => {
  sendJson(response, 200, { ...connected().readSession(target.sourceRef, target.memberId) as object,
    scopeId: target.sourceRef, memberId: target.memberId, memberName: target.memberName });
});

function requireRoom(id: string): Room {
  const room = getRoom(id);
  if (!room) throw new HttpError(404, "not_found", "Room not found");
  return room;
}
function roomResponse(room: Room) {
  return { ...room, members: getRoomMembers(room.id).map(member => member.name),
    agentStatuses: actions?.roomStatuses?.(room.id) ?? {} };
}
function invalidRoomWrite(message: string): never {
  throw new HttpError(400, "invalid_request", message);
}
async function roomWriteValue<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RoomWriteError) {
      const missing = error.reason === "member_not_found";
      throw new HttpError(missing ? 404 : 400, missing ? "not_found" : "invalid_request", error.message);
    }
    return requestValue(() => { throw error; });
  }
}
async function exactRoomWriteBody(
  request: Parameters<typeof parseBody>[0],
  allowedFields: readonly string[],
): Promise<Record<string, unknown>> {
  const raw = await requestValue(() => parseBody(request));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidRoomWrite("Request body must be an object");
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter(field => !allowedFields.includes(field));
  if (unknown.length) invalidRoomWrite(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  return body;
}
function validOptionalString(body: Record<string, unknown>, field: string, nullable = false): void {
  if (!Object.hasOwn(body, field)) return;
  if (typeof body[field] !== "string" && !(nullable && body[field] === null)) {
    invalidRoomWrite(`${field} must be ${nullable ? "a string or null" : "a string"}`);
  }
}
addRoute("GET", "/api/rooms", async (_request, response) => {
  sendJson(response, 200, listRooms().map(roomResponse));
});
addRoute("POST", "/api/rooms", async (request, response) => {
  const body = await exactRoomWriteBody(request, ["name", "memberIds", "leaderMemberId", "description", "docsPath"]);
  if (typeof body.name !== "string" || !body.name.trim()) invalidRoomWrite("name is required");
  const name = body.name as string;
  if (!Array.isArray(body.memberIds) || body.memberIds.some(id => typeof id !== "string" || !isMemberId(id))) {
    invalidRoomWrite("memberIds must contain stable member IDs");
  }
  validOptionalString(body, "leaderMemberId", true);
  validOptionalString(body, "description");
  validOptionalString(body, "docsPath", true);
  const memberIds = body.memberIds as string[];
  const leaderMemberId = body.leaderMemberId as string | null | undefined;
  if (leaderMemberId && !isMemberId(leaderMemberId)) invalidRoomWrite("leaderMemberId must be a stable member ID or null");
  const room = await roomWriteValue(() => createRoom(name.trim(), memberIds, {
    promptLeaderMemberId: leaderMemberId ?? undefined,
    docsPath: body.docsPath as string | null | undefined,
    description: body.description as string | undefined,
  }));
  sendJson(response, 200, roomResponse(room));
});
addRoute("GET", "/api/rooms/:id", async (_request, response, params) => {
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});
addRoute("DELETE", "/api/rooms/:id", async (_request, response, params) => {
  const remove=connected().deleteRoom;
  if(!remove)throw new HttpError(503,"unavailable","Room deletion is not connected");
  if(!await remove(params.id))throw new HttpError(404,"not_found","Room not found");
  sendJson(response, 200, { ok: true });
});
addRoute("PATCH", "/api/rooms/:id", async (request, response, params) => {
  const body = await exactRoomWriteBody(request, ["name", "description", "promptLeaderMemberId", "docsPath"]);
  if (!Object.keys(body).length) invalidRoomWrite("At least one room field is required");
  validOptionalString(body, "name");
  validOptionalString(body, "description", true);
  validOptionalString(body, "promptLeaderMemberId", true);
  validOptionalString(body, "docsPath", true);
  if (Object.hasOwn(body, "name") && !(body.name as string).trim()) invalidRoomWrite("name must not be empty");
  const leaderMemberId = body.promptLeaderMemberId as string | null | undefined;
  if (leaderMemberId && !isMemberId(leaderMemberId)) invalidRoomWrite("promptLeaderMemberId must be a stable member ID or null");
  const updated = await roomWriteValue(() => updateRoom(params.id, body as {
    name?: string; description?: string | null; promptLeaderMemberId?: string | null; docsPath?: string | null;
  }));
  if (!updated) throw new HttpError(404, "not_found", "Room not found");
  sendJson(response, 200, roomResponse(updated));
});

function parseAttachments(sourceRef: string, raw: unknown): RoomMessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const location = attachmentLocation(parseConversation(sourceRef)!);
  return raw.map((value: { storedFilename?: string; originalFilename?: string; size?: number }) => {
    const storedFilename = String(value?.storedFilename || "").trim();
    if (!storedFilename || !attachmentExists(location, storedFilename)) throw new Error(`Attachment not found: ${storedFilename || "(missing filename)"}`);
    const originalFilename = displayFilename(value.originalFilename || storedFilename);
    return {
      id: storedFilename,
      storedFilename,
      originalFilename,
      ...(typeof value.size === "number" ? { size: value.size } : {}),
      previewType: inferAttachmentPreviewType(originalFilename),
    };
  });
}
function replyTarget(sourceRef: string, raw: unknown): Message["replyTo"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const seq = Number((raw as { seq?: unknown }).seq);
  if (!Number.isSafeInteger(seq)) throw new Error("replyTo.seq must be an integer");
  const message = pageMessages(sourceRef, { fromSeq: seq - 1, limit: 1 }).find((candidate) => candidate.seq === seq);
  if (!message) throw new Error(`Reply target not found: msg:#${seq}`);
  return { seq, messageId: message.id };
}
async function postUserMessage(sourceRef: string, request: Parameters<typeof parseBody>[0]): Promise<Message> {
  const body = await parseBody(request) as {
    content?: string; replyTo?: unknown; attachments?: unknown; artifacts?: unknown;
  };
  const content = typeof body.content === "string" ? body.content : "";
  const attachments = parseAttachments(sourceRef, body.attachments);
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map(String).map((value) => value.trim()).filter(Boolean) : [];
  if (!content.trim() && !attachments.length && !artifacts.length) throw new Error("content, attachments, or artifacts is required");
  const ref = parseConversation(sourceRef)!;
  const mentions = ref.kind === "room" ? parseMentions(content, getRoomMembers(ref.roomId)) : { labels: [], memberIds: [] };
  const replyTo = replyTarget(sourceRef, body.replyTo);
  return await connected().postMessage(sourceRef, {
    sender: "user",
    content,
    mentions: mentions.labels,
    mentionMemberIds: mentions.memberIds,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  });
}

function conversationSource(sourceRef: string): string | null {
  return resolveConversation(sourceRef)?.scopeId ?? null;
}

type ConversationHandler = (request: Parameters<RouteHandler>[0], response: Parameters<RouteHandler>[1], sourceRef: string) => Promise<void>;
function addConversationRoute(method: string, path: string, handler: ConversationHandler): void {
  addRoute(method, path, async (request, response, params) => {
    const sourceRef = conversationSource(params.scope);
    if (!sourceRef) throw new HttpError(404, "conversation_not_found", "Conversation not found");
    await handler(request, response, sourceRef);
  });
}
addConversationRoute("GET", "/api/conversations/:scope/messages", async (request, response, sourceRef) => {
  const url = requestUrl(request);
  const messages = pageMessages(sourceRef, { limit: Number(url.searchParams.get("limit") || 100),
    before: url.searchParams.get("before") || undefined, around: url.searchParams.get("around") || undefined,
    fromSeq: url.searchParams.has("from_seq") ? Number(url.searchParams.get("from_seq")) : undefined });
  sendJson(response, 200, { scopeId: sourceRef, messages });
});
addConversationRoute("POST", "/api/conversations/:scope/messages", async (request, response, sourceRef) => {
  const message = await requestValue(() => postUserMessage(sourceRef, request));
  sendJson(response, 200, { scopeId: sourceRef, message });
});
addConversationRoute("GET", "/api/conversations/:scope/messages/search", async (request, response, sourceRef) => {
  const url = requestUrl(request);
  sendJson(response, 200, searchMessages(sourceRef, {
    query: url.searchParams.get("query") || undefined, from: url.searchParams.get("from") || undefined,
    fromMemberId: url.searchParams.get("fromMemberId") || undefined,
    after: url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined,
    before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
  }));
});

addRoute("GET", "/api/rooms/:id/members", async (_request, response, params) => {
  requireRoom(params.id);
  sendJson(response, 200, getRoomMembers(params.id).map((identity) => {
    const member = getMember(identity.id)!;
    return {
      ...identity, title: member.title, agentTemplate: member.agentTemplate,
      model: member.global.model ?? null, credentialId: member.global.credentialId ?? null,
      thinkingLevel: member.global.thinkingLevel ?? null,
      skills: member.global.skills ?? [], mcpServers: member.global.mcpServers ?? [],
    };
  }));
});
addRoute("POST", "/api/rooms/:id/members", async (request, response, params) => {
  const body = await exactRoomWriteBody(request, ["memberId"]);
  if (typeof body.memberId !== "string" || !isMemberId(body.memberId)) invalidRoomWrite("memberId must be a stable member ID");
  const result = inviteRoomMember(params.id, body.memberId);
  if (!result.ok) return sendJson(response, result.code === "duplicate" ? 409 : 404, { error: result.error });
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});
addRoute("DELETE", "/api/rooms/:id/members/:memberId", async (_request, response, params) => {
  const result = removeRoomMember(params.id, params.memberId);
  if (!result.ok) return sendJson(response, 404, { error: result.error });
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});

addRoute("PUT","/api/conversations/:scope/pin",async(request,response,params)=>{
 const ref=resolveConversation(params.scope);if(!ref||ref.kind==='mm')throw new HttpError(404,"not_found","Chat not found");
 const body=await parseBody(request);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='pinned')||typeof (body as {pinned?:unknown}).pinned!=='boolean')throw new HttpError(400,"invalid_request","pinned must be a boolean");
 const pinned=(body as {pinned:boolean}).pinned,pinnedAt=setChatPinned(ref.scopeId,pinned);
 sendJson(response,200,{scopeId:ref.scopeId,pinned,pinnedAt});
});
