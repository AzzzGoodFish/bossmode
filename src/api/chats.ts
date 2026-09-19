import { readConfig } from "../config/settings.js";
import {
  createRoom,
  deleteRoom,
  getRoom,
  getRoomMembers,
  inviteGlobalMember,
  listMmScopes,
  listRooms,
  normalizeRoomDocsPath,
  parseConversation,
  parseMmScopeId,
  removeRoomMemberByRef,
  resolveRoomMemberRef,
  scopeIdOf,
  updateRoomDescription,
  updateRoomDocsPath,
  updateRoomName,
  updateRoomPromptLeader,
  updateRoomRuleDocs,
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
import { attachmentExists, displayFilename, inferAttachmentPreviewType, type AttachmentLocation, type RoomMessageAttachment } from "../files/attachments.js";
import { getMember, listMembers } from "../member/identity.js";
import { logger } from "../kernel/logger.js";
import { addRoute, parseBody, requestUrl, sendJson } from "./http.js";

export interface ChatHttpActions {
  postMessage(sourceRef: string, input: MessageInput): Promise<Message> | Message;
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
  try {
    const chats = [
      ...listMembers().map((member) => chatSummary(`dm:${member.id}`, "dm" as const, member.name)),
      ...listRooms().map((room) => chatSummary(`room:${room.id}`, "room" as const, room.name)),
    ].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
    sendJson(response, 200, { chats });
  } catch (error) {
    logger.error("api", "chat list failed", { error: String(error) });
    sendJson(response, 500, { error: "internal", message: String(error) });
  }
});

addRoute("POST", "/api/conversations/:scope/read", async (request, response, params) => {
  const sourceRef = decodeURIComponent(params.scope);
  if (!parseConversation(sourceRef)) return sendJson(response, 400, { error: "scope_not_found" });
  const body = await parseBody(request) as { messageId?: string | null; seq?: number | null };
  const last = body.messageId === undefined && body.seq === undefined ? readMessages(sourceRef).at(-1) : undefined;
  const cursor = setUserReadCursor(sourceRef, {
    messageId: body.messageId === undefined ? last?.id ?? null : body.messageId,
    seq: body.seq === undefined ? last?.seq ?? null : body.seq,
  });
  sendJson(response, 200, { scopeId: sourceRef, cursor });
});

function roomResponse(room: Room) {
  return { ...room, agentStatuses: actions?.roomStatuses?.(room.id) ?? {}, agentStale: {} };
}
addRoute("GET", "/api/rooms", async (_request, response) => {
  sendJson(response, 200, listRooms().map(roomResponse));
});
addRoute("POST", "/api/rooms", async (request, response) => {
  const body = await parseBody(request) as {
    name?: string; memberIds?: unknown; leaderMemberId?: string | null; description?: string;
    ruleDocs?: string[]; docsPath?: string | null;
  };
  if (typeof body.name !== "string" || !body.name.trim()) return sendJson(response, 400, { error: "name is required" });
  if (!Array.isArray(body.memberIds) || body.memberIds.some((id) => typeof id !== "string" || !id || id.trim() !== id)) {
    return sendJson(response, 400, { error: "memberIds must contain stable member IDs" });
  }
  try {
    const room = createRoom(body.name.trim(), undefined, body.memberIds as string[], body.ruleDocs, {
      promptLeaderMemberId: body.leaderMemberId ?? undefined,
      docsPath: body.docsPath,
      description: body.description,
    });
    sendJson(response, 200, roomResponse(room));
  } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
});
addRoute("GET", "/api/rooms/:id", async (_request, response, params) => {
  const room = getRoom(params.id);
  if (!room) return sendJson(response, 404, { error: "Room not found" });
  sendJson(response, 200, roomResponse(room));
});
addRoute("DELETE", "/api/rooms/:id", async (_request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  deleteRoom(params.id);
  sendJson(response, 200, { ok: true });
});
addRoute("PATCH", "/api/rooms/:id", async (request, response, params) => {
  const room = getRoom(params.id);
  if (!room) return sendJson(response, 404, { error: "Room not found" });
  const body = await parseBody(request) as {
    name?: string; description?: string | null; ruleDocs?: string[];
    promptLeaderMemberId?: string | null; docsPath?: string | null;
  };
  let updated: Room | null = room;
  let changed = false;
  try {
    if (typeof body.name === "string" && body.name.trim() && body.name !== room.name) { updated = updateRoomName(room.id, body.name.trim()); changed = true; }
    if (Object.hasOwn(body, "description")) { updated = updateRoomDescription(room.id, body.description ?? ""); changed = true; }
    if (Array.isArray(body.ruleDocs)) { updated = updateRoomRuleDocs(room.id, body.ruleDocs); changed = true; }
    if (Object.hasOwn(body, "promptLeaderMemberId")) { updated = updateRoomPromptLeader(room.id, body.promptLeaderMemberId ?? null); changed = true; }
    if (Object.hasOwn(body, "docsPath")) {
      normalizeRoomDocsPath(body.docsPath);
      updated = updateRoomDocsPath(room.id, body.docsPath ?? null); changed = true;
    }
  } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  if (!changed || !updated) return sendJson(response, 400, { error: "Nothing to update" });
  sendJson(response, 200, roomResponse(updated));
});

function attachmentLocation(sourceRef: string): AttachmentLocation {
  const ref = parseConversation(sourceRef);
  if (!ref) throw new Error("Invalid conversation");
  if (ref.kind === "room") return { kind: "room", roomId: ref.roomId };
  if (ref.kind === "dm") return { kind: "dm", memberId: ref.memberId };
  return { kind: "mm", memberIds: ref.memberIds };
}
function parseAttachments(sourceRef: string, raw: unknown): RoomMessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const location = attachmentLocation(sourceRef);
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
  return await connected().postMessage(sourceRef, {
    sender: "user",
    content,
    mentions: mentions.labels,
    mentionMemberIds: mentions.memberIds,
    ...(replyTarget(sourceRef, body.replyTo) ? { replyTo: replyTarget(sourceRef, body.replyTo)! } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  });
}

function registerMessageRoutes(kind: "rooms" | "dm", source: (params: Record<string, string>) => string, exists: (params: Record<string, string>) => boolean): void {
  const base = kind === "rooms" ? "/api/rooms/:id/messages" : "/api/dm/:memberId/messages";
  addRoute("GET", base, async (request, response, params) => {
    if (!exists(params)) return sendJson(response, 404, { error: kind === "rooms" ? "Room not found" : "Member not found" });
    const url = requestUrl(request);
    const messages = pageMessages(source(params), {
      limit: Number(url.searchParams.get("limit") || 100),
      before: url.searchParams.get("before") || undefined,
      around: url.searchParams.get("around") || undefined,
      fromSeq: url.searchParams.has("from_seq") ? Number(url.searchParams.get("from_seq")) : undefined,
    });
    sendJson(response, 200, kind === "dm" ? { messages } : messages);
  });
  addRoute("POST", base, async (request, response, params) => {
    if (!exists(params)) return sendJson(response, 404, { error: kind === "rooms" ? "Room not found" : "Member not found" });
    try {
      const message = await postUserMessage(source(params), request);
      sendJson(response, 200, kind === "dm" ? { message } : message);
    } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
}
registerMessageRoutes("rooms", (params) => `room:${params.id}`, (params) => Boolean(getRoom(params.id)));
registerMessageRoutes("dm", (params) => `dm:${params.memberId}`, (params) => Boolean(getMember(params.memberId)));

addRoute("GET", "/api/rooms/:id/messages/search", async (request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  const url = requestUrl(request);
  sendJson(response, 200, searchMessages(`room:${params.id}`, {
    query: url.searchParams.get("query") || undefined,
    from: url.searchParams.get("from") || undefined,
    fromMemberId: url.searchParams.get("fromMemberId") || undefined,
    after: url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined,
    before: url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined,
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
    offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
  }));
});

addRoute("GET", "/api/rooms/:id/members", async (_request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  sendJson(response, 200, getRoomMembers(params.id));
});
addRoute("POST", "/api/rooms/:id/members", async (request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  const body = await parseBody(request) as { memberId?: string };
  const member = body.memberId ? getMember(body.memberId) : null;
  if (!member) return sendJson(response, 404, { error: "Member not found" });
  const result = inviteGlobalMember(params.id, { id: member.id, name: member.name, agentTemplate: member.agentTemplate });
  if (!result.ok) return sendJson(response, result.code === "duplicate" ? 409 : 400, { error: result.error });
  sendJson(response, 200, getRoom(params.id));
});
addRoute("DELETE", "/api/rooms/:id/members/:memberRef", async (_request, response, params) => {
  const member = resolveRoomMemberRef(params.id, params.memberRef);
  if (!member) return sendJson(response, 404, { error: "Member is not in this room" });
  const result = removeRoomMemberByRef(params.id, params.memberRef, { globalMemberId: member.sourceMemberId ?? member.id });
  if (!result.ok) return sendJson(response, 404, { error: result.error });
  sendJson(response, 200, getRoom(params.id));
});

export interface MemberChatSummary {
  scopeId: string;
  members: Array<{ id: string; name: string }>;
  lastMessage: { id: string; ts: number; sender: string; senderMemberId?: string } | null;
  messageCount: number;
}
export function listMemberChats(): MemberChatSummary[] {
  return listMmScopes().map((scopeId) => {
    const pair = parseMmScopeId(scopeId)!;
    const messages = readMessages(scopeId);
    const last = messages.at(-1);
    return {
      scopeId,
      members: pair.map((id) => ({ id, name: getMember(id)?.name ?? id })),
      lastMessage: last ? { id: last.id, ts: last.ts, sender: last.sender, ...(last.senderMemberId ? { senderMemberId: last.senderMemberId } : {}) } : null,
      messageCount: messages.length,
    };
  }).sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
}
addRoute("GET", "/api/member-chats", async (_request, response) => sendJson(response, 200, { chats: listMemberChats() }));
addRoute("GET", "/api/member-chats/messages", async (request, response) => {
  const url = requestUrl(request);
  const scopeId = url.searchParams.get("scope") || "";
  if (!parseMmScopeId(scopeId)) return sendJson(response, 400, { error: "unknown_member_chat" });
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 100), 500));
  const page = pageMessages(scopeId, { before: url.searchParams.get("before") || undefined, limit: limit + 1 });
  sendJson(response, 200, { scopeId, messages: page.slice(-limit), hasMore: page.length > limit });
});
addRoute("POST", "/api/member-chats/read", async (request, response) => {
  const body = await parseBody(request) as { scope?: string; messageId?: string | null };
  const scopeId = String(body.scope || "");
  if (!parseMmScopeId(scopeId)) return sendJson(response, 400, { error: "unknown_member_chat" });
  const messages = readMessages(scopeId);
  const target = body.messageId ? messages.find((message) => message.id === body.messageId) : messages.at(-1);
  setUserReadCursor(scopeId, { messageId: target?.id ?? null, seq: target?.seq ?? null });
  sendJson(response, 200, { ok: true });
});

for (const path of [
  "/api/rooms/:id/principles",
  "/api/rooms/:id/members/:memberRef/principles",
  "/api/rooms/:id/members/:memberRef/mainline",
  "/api/rooms/:id/contract-drift",
]) addRoute("GET", path, async (_request, response) => sendJson(response, 410, { error: "gone" }));
