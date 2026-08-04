/**
 * 0.20 Members / Contacts / DM REST surface (WS-A).
 * Contract §2.1 / §2.2 partial (global member ids on rooms stamped by migration).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../foundation/logger.js";
import {
  listMembers,
  getMember,
  createMember,
  updateMember,
  renameMember,
  fireMember,
  resolveMemberRef,
  getEffectiveConfig,
  patchScopeOverride,
  MemberNameTakenError,
  MemberNotFoundError,
  type MemberRecord,
} from "../workspace/member-registry.js";
import { readMemoryLayer } from "../workspace/member-memory-store.js";
import { listArchives, importMemberFromArchive } from "../workspace/member-archive.js";
import {
  readAllDmMessages,
  addDmMessage,
  getLatestDmSeq,
  getDmCursor,
} from "../workspace/dm-message-store.js";
import { parseScopeId, scopeIdOf, type ScopeId } from "../shared/conversation-ref.js";
import * as roomStore from "../workspace/room-store.js";
import * as messageStore from "../workspace/message-store.js";
import type { RoomMessage } from "../shared/types.js";

function publicMember(m: MemberRecord) {
  return {
    memberId: m.id,
    id: m.id,
    name: m.name,
    agentTemplate: m.agentTemplate,
    unifiedModel: m.unifiedModel,
    unifiedExtensions: m.unifiedExtensions,
    global: m.global,
    scopeOverrides: m.scopeOverrides,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function errCode(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof MemberNameTakenError) {
    return { status: 409, error: "name_taken", message: err.message };
  }
  if (err instanceof MemberNotFoundError) {
    return { status: 404, error: "not_found", message: err.message };
  }
  const msg = String((err as any)?.message || err);
  if (msg === "confirm_required") return { status: 400, error: "confirm_required", message: "confirm: true required" };
  if (msg === "invalid_member_name") return { status: 400, error: "invalid_member_name", message: msg };
  if (msg === "scope_not_found") return { status: 400, error: "scope_not_found", message: msg };
  if (msg === "archive_not_found") return { status: 404, error: "archive_not_found", message: msg };
  return { status: 500, error: "internal", message: msg };
}

function summarizeMessage(m: RoomMessage | undefined): { sender: string; text: string; ts: number } | null {
  if (!m) return null;
  const text = (m.content || "").replace(/\s+/g, " ").trim().slice(0, 140);
  return { sender: m.sender, text, ts: m.ts };
}

function countUnreadAndMention(
  messages: RoomMessage[],
  cursorId: string | null,
  cursorSeq: number | null,
  selfNames: Set<string>,
  selfIds: Set<string>,
): { unreadCount: number; mentioned: boolean } {
  let start = 0;
  if (cursorSeq != null) {
    const idx = messages.findIndex((m) => typeof m.seq === "number" && m.seq > cursorSeq);
    start = idx === -1 ? messages.length : idx;
  } else if (cursorId) {
    const idx = messages.findIndex((m) => m.id === cursorId);
    start = idx === -1 ? 0 : idx + 1;
  }
  const slice = messages.slice(start);
  let mentioned = false;
  for (const m of slice) {
    if (m.sender === "user" || m.sender === "system") continue;
    if (m.mentionMemberIds?.some((id) => selfIds.has(id))) mentioned = true;
    if (m.mentions?.some((n) => selfNames.has(n))) mentioned = true;
  }
  // Unread = messages after cursor not sent by user (rough chat-app semantics)
  const unreadCount = slice.filter((m) => m.sender !== "user").length;
  return { unreadCount, mentioned };
}

// ── Chats (unified conversation list) ──

addRoute("GET", "/api/chats", async (_req, res) => {
  try {
    const members = listMembers();
    const rooms = roomStore.listRooms();
    const chats: Array<{
      scopeId: string;
      kind: "dm" | "room";
      title: string;
      lastMessage: { sender: string; text: string; ts: number } | null;
      unreadCount: number;
      mentioned: boolean;
      status: string;
    }> = [];

    for (const m of members) {
      const msgs = readAllDmMessages(m.id);
      const last = msgs[msgs.length - 1];
      const cursor = getDmCursor(m.id);
      const { unreadCount, mentioned } = countUnreadAndMention(
        msgs,
        cursor.messageId,
        cursor.seq,
        new Set([m.name]),
        new Set([m.id]),
      );
      chats.push({
        scopeId: scopeIdOf({ kind: "dm", memberId: m.id }),
        kind: "dm",
        title: m.name,
        lastMessage: summarizeMessage(last),
        unreadCount,
        mentioned,
        status: "idle",
      });
    }

    for (const room of rooms) {
      const msgs = messageStore.readAllMessages(room.id);
      const last = msgs[msgs.length - 1];
      const cursors = roomStore.getCursors(room.id);
      // Aggregate unread across room members using the "latest" cursor lag for user-facing list:
      // use the room's prompt leader cursor if present, else max cursor coverage.
      const roomMembers = roomStore.getRoomMembers(room.id);
      const leader = roomMembers.find((rm) => rm.id === room.promptLeaderMemberId);
      const cursorKey = leader?.id || roomMembers[0]?.id || "";
      const cursorId = cursorKey ? (cursors[cursorKey] ?? null) : null;
      const selfNames = new Set(roomMembers.map((rm) => rm.name));
      const selfIds = new Set(roomMembers.map((rm) => rm.id));
      const { unreadCount, mentioned } = countUnreadAndMention(msgs, cursorId, null, selfNames, selfIds);
      chats.push({
        scopeId: scopeIdOf({ kind: "room", roomId: room.id }),
        kind: "room",
        title: room.name,
        lastMessage: summarizeMessage(last),
        unreadCount,
        mentioned,
        status: "idle",
      });
    }

    chats.sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
    sendJson(res, 200, { chats });
  } catch (err) {
    logger.error("members-api", "chats failed", { error: String(err) });
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

// ── Contacts (directory) ──

addRoute("GET", "/api/contacts", async (_req, res) => {
  try {
    const rooms = roomStore.listRooms();
    const contacts = listMembers().map((m) => {
      const activeScopes: string[] = [];
      // Scope membership from room.globalMemberIds (0.20) or name match in roomMembers (legacy)
      for (const room of rooms) {
        const inGlobal = room.globalMemberIds?.includes(m.id);
        const inLegacy = roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name);
        if (inGlobal || inLegacy) activeScopes.push(scopeIdOf({ kind: "room", roomId: room.id }));
      }
      // Always include dm scope identity
      activeScopes.unshift(scopeIdOf({ kind: "dm", memberId: m.id }));
      return {
        memberId: m.id,
        name: m.name,
        agentTemplate: m.agentTemplate,
        status: "idle" as const, // WS-B fills live status
        activeScopes,
        model: m.global.model ?? null,
        contextPct: null as number | null,
        tokensToday: 0,
        tokensTotal: 0,
        unifiedModel: m.unifiedModel,
        unifiedExtensions: m.unifiedExtensions,
      };
    });
    sendJson(res, 200, { contacts });
  } catch (err) {
    logger.error("members-api", "contacts failed", { error: String(err) });
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

// ── Members CRUD ──

addRoute("GET", "/api/members", async (_req, res) => {
  sendJson(res, 200, { members: listMembers().map(publicMember) });
});

addRoute("GET", "/api/members/archive-list", async (_req, res) => {
  try {
    sendJson(res, 200, { archives: listArchives() });
  } catch (err) {
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

addRoute("POST", "/api/members", async (req, res) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      agentTemplate?: string;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      extensions?: string[];
      mcpServers?: string[];
      unifiedModel?: boolean;
      unifiedExtensions?: boolean;
      importFromArchive?: string;
    };
    if (!body.name?.trim()) {
      sendJson(res, 400, { error: "invalid_member_name", message: "name is required" });
      return;
    }
    let member: MemberRecord;
    if (body.importFromArchive) {
      member = importMemberFromArchive({
        archivePath: body.importFromArchive,
        name: body.name.trim(),
        agentTemplate: body.agentTemplate,
        credentialId: body.credentialId,
      });
      if (body.model !== undefined || body.unifiedModel !== undefined) {
        member = updateMember(member.id, {
          unifiedModel: body.unifiedModel,
          global: {
            model: body.model,
            credentialId: body.credentialId,
            thinkingLevel: body.thinkingLevel,
          },
        });
      }
    } else {
      member = createMember({
        name: body.name,
        agentTemplate: body.agentTemplate || "general",
        model: body.model,
        credentialId: body.credentialId,
        thinkingLevel: body.thinkingLevel,
        skills: body.skills,
        extensions: body.extensions,
        mcpServers: body.mcpServers,
        unifiedModel: body.unifiedModel,
        unifiedExtensions: body.unifiedExtensions,
      });
    }
    sendJson(res, 200, { member: publicMember(member) });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  sendJson(res, 200, { member: publicMember(m) });
});

addRoute("PATCH", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      unifiedModel?: boolean;
      unifiedExtensions?: boolean;
      agentTemplate?: string;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      extensions?: string[];
      mcpServers?: string[];
    };
    let m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    if (body.name && body.name.trim() !== m.name) {
      m = renameMember(m.id, body.name);
    }
    m = updateMember(m.id, {
      unifiedModel: body.unifiedModel,
      unifiedExtensions: body.unifiedExtensions,
      agentTemplate: body.agentTemplate,
      global: {
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.credentialId !== undefined ? { credentialId: body.credentialId } : {}),
        ...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
        ...(body.skills !== undefined ? { skills: body.skills } : {}),
        ...(body.extensions !== undefined ? { extensions: body.extensions } : {}),
        ...(body.mcpServers !== undefined ? { mcpServers: body.mcpServers } : {}),
      },
    });
    sendJson(res, 200, { member: publicMember(m) });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("DELETE", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as { confirm?: boolean };
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const result = fireMember(m.id, { confirm: !!body.confirm });
    sendJson(res, 200, result);
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id/scopes", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  const scopes: Array<{ scopeId: string; kind: string; label: string; status: string; lastActiveAt: number | null }> = [
    { scopeId: scopeIdOf({ kind: "dm", memberId: m.id }), kind: "dm", label: "Direct message", status: "idle", lastActiveAt: null },
  ];
  for (const room of roomStore.listRooms()) {
    const inGlobal = room.globalMemberIds?.includes(m.id);
    const inLegacy = roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name);
    if (inGlobal || inLegacy) {
      scopes.push({
        scopeId: scopeIdOf({ kind: "room", roomId: room.id }),
        kind: "room",
        label: room.name,
        status: "idle",
        lastActiveAt: null,
      });
    }
  }
  sendJson(res, 200, { scopes });
});

addRoute("GET", "/api/members/:id/memory", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const layer = (url.searchParams.get("layer") || "persona") as "persona" | "principles" | "mainline";
    const scope = url.searchParams.get("scope") || undefined;
    if (layer !== "persona" && !scope) {
      sendJson(res, 400, { error: "scope_required", message: "scope required for principles/mainline" });
      return;
    }
    if (scope && !parseScopeId(scope)) {
      sendJson(res, 400, { error: "scope_not_found", message: "invalid scope" });
      return;
    }
    const data = readMemoryLayer(m.id, layer, scope as ScopeId | undefined);
    sendJson(res, 200, { content: data.content, meta: data.meta });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id/effective-config", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const scope = url.searchParams.get("scope") || scopeIdOf({ kind: "dm", memberId: m.id });
    if (!parseScopeId(scope)) {
      sendJson(res, 400, { error: "scope_not_found", message: "invalid scope" });
      return;
    }
    sendJson(res, 200, getEffectiveConfig(m.id, scope));
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("PATCH", "/api/members/:id/config", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const scope = url.searchParams.get("scope");
    if (!scope || !parseScopeId(scope)) {
      sendJson(res, 400, { error: "scope_not_found", message: "scope query required" });
      return;
    }
    const body = (await parseBody(req)) as Record<string, unknown>;
    // null clears override field
    const diff: Record<string, unknown> = {};
    for (const key of ["model", "credentialId", "thinkingLevel", "skills", "extensions", "mcpServers"]) {
      if (Object.prototype.hasOwnProperty.call(body, key)) diff[key] = body[key];
    }
    const updated = patchScopeOverride(m.id, scope, diff as any);
    sendJson(res, 200, {
      member: publicMember(updated),
      effective: getEffectiveConfig(m.id, scope),
    });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

// ── DM messages ──

addRoute("GET", "/api/dm/:memberId/messages", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.memberId);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const before = url.searchParams.get("before");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
    let messages = readAllDmMessages(m.id);
    if (before) {
      const idx = messages.findIndex((msg) => msg.id === before || String(msg.seq) === before);
      if (idx > 0) messages = messages.slice(0, idx);
    }
    if (messages.length > limit) messages = messages.slice(-limit);
    sendJson(res, 200, { messages });
  } catch (err) {
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

addRoute("POST", "/api/dm/:memberId/messages", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.memberId);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const body = (await parseBody(req)) as { text?: string; content?: string; attachments?: unknown };
    const text = (body.text ?? body.content ?? "").toString();
    if (!text.trim() && !body.attachments) {
      sendJson(res, 400, { error: "empty", message: "text is required" });
      return;
    }
    const message = addDmMessage(m.id, {
      sender: "user",
      content: text,
      mentions: [],
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments as any } : {}),
    });
    // Activation is WS-B; data layer only persists.
    sendJson(res, 200, { message });
  } catch (err) {
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

addRoute("GET", "/api/dm/:memberId/session", async (_req, res, params) => {
  const m = resolveMemberRef(params.memberId);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  sendJson(res, 200, {
    memberId: m.id,
    scopeId: scopeIdOf({ kind: "dm", memberId: m.id }),
    status: "idle",
    contextPct: null,
    latestSeq: getLatestDmSeq(m.id),
  });
});
