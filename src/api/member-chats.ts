/**
 * Member↔member private chats — user read-only surface (⑤ B/C, fish #20135).
 *
 * The user is never a participant: these endpoints list pair chats and page
 * their messages read-only, plus a user read cursor per pair scope. Members
 * keep their own cursors through the chat tools.
 */
import { addRoute, sendJson, parseBody } from "./index.js";
import { ConversationsRepository } from "../data/repositories/conversations.js";
import { pageMessages } from "../data/repositories/message-repository.js";
import { parseMmScopeId } from "../shared/conversation-ref.js";
import { getMember } from "../member/member-registry.js";
import { readAllMmMessages } from "../chat/mm-message-store.js";
import { setUserReadCursor } from "../chat/user-read-cursors.js";
import type { RoomMessage } from "../kernel/types.js";

export interface MemberChatSummary {
  scopeId: string;
  members: Array<{ id: string; name: string }>;
  lastMessage: { id: string; ts: number; sender: string; senderMemberId?: string } | null;
  messageCount: number;
}

/** All pair chats, newest activity first; unknown members fall back to their id. */
export function listMemberChats(): MemberChatSummary[] {
  const scopes = new ConversationsRepository().listMmScopes();
  const summaries = scopes.map((scopeId): MemberChatSummary => {
    const pair = parseMmScopeId(scopeId)!;
    const all = readAllMmMessages(scopeId);
    const last = all[all.length - 1];
    return {
      scopeId,
      members: pair.map((id) => ({ id, name: getMember(id)?.name ?? id })),
      lastMessage: last
        ? { id: last.id, ts: last.ts, sender: last.sender, ...(last.senderMemberId ? { senderMemberId: last.senderMemberId } : {}) }
        : null,
      messageCount: all.length,
    };
  });
  return summaries.sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
}

/** Read-only message page for one pair scope, newest page by default. */
export function readMemberChatMessages(scopeId: string, opts: { limit?: number; before?: string } = {}): { messages: RoomMessage[]; hasMore: boolean } {
  if (!parseMmScopeId(scopeId)) throw new Error("unknown_member_chat");
  const limit = Math.max(1, Math.min(Number.isFinite(opts.limit) ? Number(opts.limit) : 100, 500));
  const page = pageMessages(scopeId, { before: opts.before, limit: limit + 1 });
  const hasMore = page.length > limit;
  return { messages: hasMore ? page.slice(page.length - limit) : page, hasMore };
}

/** Mark the pair chat read for the user; null message id = latest. */
export function markMemberChatRead(scopeId: string, messageId: string | null = null): void {
  if (!parseMmScopeId(scopeId)) throw new Error("unknown_member_chat");
  const target = messageId ?? readAllMmMessages(scopeId).at(-1)?.id ?? null;
  setUserReadCursor(scopeId, { messageId: target });
}

addRoute("GET", "/api/member-chats", async (_req, res) => {
  sendJson(res, 200, { chats: listMemberChats() });
});

addRoute("GET", "/api/member-chats/messages", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const scope = url.searchParams.get("scope") || "";
  try {
    const limitRaw = url.searchParams.get("limit");
    const data = readMemberChatMessages(scope, {
      ...(limitRaw ? { limit: Number(limitRaw) } : {}),
      ...(url.searchParams.get("before") ? { before: String(url.searchParams.get("before")) } : {}),
    });
    sendJson(res, 200, { scopeId: scope, ...data });
  } catch {
    sendJson(res, 400, { error: "unknown_member_chat" });
  }
});

addRoute("POST", "/api/member-chats/read", async (req, res) => {
  const body = (await parseBody(req)) as { scope?: string; messageId?: string | null };
  try {
    markMemberChatRead(String(body.scope || ""), body.messageId ?? null);
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { error: "unknown_member_chat" });
  }
});
