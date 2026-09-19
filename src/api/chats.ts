import { readConfig } from "../config/settings.js";
import {
  attachmentLocation,
  createRoom,
  deleteRoom,
  getRoom,
  getRoomMembers,
  inviteRoomMember,
  listMmScopes,
  listRooms,
  parseConversation,
  parseMmScopeId,
  removeRoomMember,
  resolveConversation,
  resolveRoomMember,
  updateRoom,
  type Room,
} from "../chat/conversations.js";
import { getUserReadCursor, setUserReadCursor } from "../chat/cursors.js";
import { parseMentions } from "../chat/delivery.js";
import {
  pageMessages,
  readMessages,
  searchMessages,
  type Message,
  type MessageInput,
} from "../chat/messages.js";
import { attachmentExists, displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../files/attachments.js";
import { getMember, listMembers } from "../member/identity.js";
import { addRoute, HttpError, parseBody, requestUrl, requestValue, sendJson, type RouteHandler } from "./http.js";

export interface ChatHttpActions {
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

function summarize(message: Message | undefined): { sender: string; senderMemberId?: string; text: string; ts: number } | null {
  if (!message) return null;
  return {
    sender: message.sender,
    ...(message.senderMemberId ? { senderMemberId: message.senderMemberId } : {}),
    text: message.content.replace(/\s+/g, " ").trim().slice(0, 140),
    ts: message.ts,
  };
}
function userLoginName(): string {
  try { return String((readConfig() as { username?: string }).username || "").trim(); }
  catch { return ""; }
}
export function countUserUnreadAndMention(
  messages: Message[],
  cursorId: string | null,
  cursorSeq: number | null,
  login: string,
): { unreadCount: number; mentioned: boolean } {
  let start = 0;
  if (cursorSeq !== null) {
    const found = messages.findIndex((message) => typeof message.seq === "number" && message.seq > cursorSeq);
    start = found < 0 ? messages.length : found;
  } else if (cursorId) {
    const found = messages.findIndex((message) => message.id === cursorId);
    start = found < 0 ? 0 : found + 1;
  }
  const visible = messages.slice(start).filter((message) =>
    message.sender !== "user" && message.sender !== "system" && !message.type);
  const needle = login ? `@${login}` : "";
  return { unreadCount: visible.length, mentioned: Boolean(needle && visible.some((message) => message.content.includes(needle))) };
}
function chatSummary(sourceRef: string, kind: "room" | "dm" | "mm", title: string) {
  const messages = readMessages(sourceRef);
  const cursor = getUserReadCursor(sourceRef);
  const unread = countUserUnreadAndMention(messages, cursor?.messageId ?? null, cursor?.seq ?? null, userLoginName());
  const status = actions?.scopeStatus?.(sourceRef) ?? "idle";
  return {
    scopeId: sourceRef,
    kind,
    title,
    lastMessage: summarize(messages.at(-1)),
    ...unread,
    status: status === "inactive" ? "idle" : status,
  };
}

addRoute("GET", "/api/chats", async (_request, response) => {
  const chats = [
      ...listMembers().map((member) => chatSummary(`dm:${member.id}`, "dm" as const, member.name)),
      ...listRooms().map((room) => chatSummary(`room:${room.id}`, "room" as const, room.name)),
      ...listMmScopes().map((scope) => chatSummary(scope, "mm" as const,
        parseMmScopeId(scope)!.map(id => getMember(id)?.name ?? id).join(" ↔ "))),
  ].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
  sendJson(response, 200, { chats });
});

addRoute("POST", "/api/conversations/:scope/read", async (request, response, params) => {
  const sourceRef = conversationSource(params.scope);
  if (!sourceRef) throw new HttpError(404, "conversation_not_found", "Conversation not found");
  const body = await parseBody(request) as { messageId?: string | null; seq?: number | null };
  const last = body.messageId === undefined && body.seq === undefined ? readMessages(sourceRef).at(-1) : undefined;
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
addRoute("GET", "/api/rooms", async (_request, response) => {
  sendJson(response, 200, listRooms().map(roomResponse));
});
addRoute("POST", "/api/rooms", async (request, response) => {
  const body = await parseBody(request) as {
    name?: string; memberIds?: unknown; leaderMemberId?: string | null; description?: string;
    docsPath?: string | null;
  };
  if (typeof body.name !== "string" || !body.name.trim()) return sendJson(response, 400, { error: "name is required" });
  if (!Array.isArray(body.memberIds) || body.memberIds.some((id) => typeof id !== "string" || !id || id.trim() !== id)) {
    return sendJson(response, 400, { error: "memberIds must contain stable member IDs" });
  }
  const room = await requestValue(() => createRoom(body.name!.trim(), body.memberIds as string[], {
    promptLeaderMemberId: body.leaderMemberId ?? undefined,
    docsPath: body.docsPath,
    description: body.description,
  }));
  sendJson(response, 200, roomResponse(room));
});
addRoute("GET", "/api/rooms/:id", async (_request, response, params) => {
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});
addRoute("DELETE", "/api/rooms/:id", async (_request, response, params) => {
  requireRoom(params.id); deleteRoom(params.id);
  sendJson(response, 200, { ok: true });
});
addRoute("PATCH", "/api/rooms/:id", async (request, response, params) => {
  const room = requireRoom(params.id);
  const body = await parseBody(request) as {
    name?: string; description?: string | null;
    promptLeaderMemberId?: string | null; docsPath?: string | null;
  };
  const updated = await requestValue(() => updateRoom(room.id, body));
  sendJson(response, 200, roomResponse(updated!));
});

function parseAttachments(sourceRef: string, raw: unknown): RoomMessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const location = attachmentLocation(parseConversation(sourceRef)!);
  return raw.map((value: { storedFilename?: string; filename?: string; originalFilename?: string; size?: number }) => {
    const storedFilename = displayFilename(value?.storedFilename || value?.filename || "");
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
  const message = readMessages(sourceRef).find((candidate) => candidate.seq === seq);
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
  sendJson(response, 200, getRoomMembers(params.id));
});
addRoute("POST", "/api/rooms/:id/members", async (request, response, params) => {
  requireRoom(params.id);
  const body = await parseBody(request) as { memberId?: string };
  const member = body.memberId ? getMember(body.memberId) : null;
  if (!member) return sendJson(response, 404, { error: "Member not found" });
  const result = inviteRoomMember(params.id, member.id);
  if (!result.ok) return sendJson(response, result.code === "duplicate" ? 409 : 400, { error: result.error });
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});
addRoute("DELETE", "/api/rooms/:id/members/:memberId", async (_request, response, params) => {
  const result = removeRoomMember(params.id, params.memberId);
  if (!result.ok) return sendJson(response, 404, { error: result.error });
  sendJson(response, 200, roomResponse(requireRoom(params.id)));
});
