import { readConfig } from "../config/settings.js";

import { postMessage } from "../chat/message-bus.js";
import { archiveMember } from "../app/member-actions.js";
import { updateProfileForMember, InvalidProfileError } from "../member/profile.js";
/**
 * 0.20 Members / Contacts / DM REST surface (WS-A).
 * Contract §2.1 / §2.2 partial (global member ids on rooms stamped by migration).
 */
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../kernel/logger.js";
import { listMembers, listMemberIdentities, getMember, updateMember, resolveMemberRef, getMemberConfiguration, MemberNameTakenError, MemberNotFoundError, type MemberRecord } from "../member/identity.js";
import { createMember } from "../app/member-actions.js";
import {
  readAllDmMessages,
  getLatestDmSeq,
} from "../chat/dm-message-store.js";
import { getMcpServerNames, readMcpStatusCache, readMemberMcpConfig } from "../member/mcp.js";
import { listMemberExtensions } from "../member/extensions.js";
import { listMemberSkills } from "../member/skills.js";
import { activeWorkspaceRoot, readWorkspaces } from "../member/workspaces.js";
import { readMemberSshPublicKey } from "../member/workspaces.js";
import { parseScopeId, scopeIdOf, type ScopeId } from "../chat/conversations.js";
import { switchMemberModel, switchMemberThinkingLevel } from "../agent/orchestrator/agent-manager.js";
import * as roomStore from "../chat/conversations.js";
import * as messageStore from "../chat/message-store.js";
import { getUserReadCursor, setUserReadCursor } from "../chat/user-read-cursors.js";

import type { RoomMessage } from "../kernel/types.js";
import { readMemberProfile } from "../member/profile.js";

function publicMember(m: MemberRecord) {
  return {
    memberId: m.id,
    id: m.id,
    name: m.name,
    /** Card field from database (identity batch-1; description retired batch-5). */
    title: m.title ?? null,
    agentTemplate: m.agentTemplate,
    global: m.global,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function errCode(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof InvalidProfileError) return { status: 400, error: err.code, message: err.message };
  if (err instanceof MemberNameTakenError) {
    return { status: 409, error: "name_taken", message: err.message };
  }
  if (err instanceof MemberNotFoundError) {
    return { status: 404, error: "not_found", message: err.message };
  }
  const msg = String((err as any)?.message || err);
  if (msg === "confirm_required") return { status: 400, error: "confirm_required", message: "confirm: true required" };
  if (msg === "reserved_member_name") return { status: 400, error: msg, message: "all, user and system are reserved for group mentions, the human user and system messages." };
  if (msg === "invalid_member_name") return { status: 400, error: "invalid_member_name", message: msg };
  if (msg === "scope_not_found") return { status: 400, error: "scope_not_found", message: msg };
  if (msg === "archive_not_found") return { status: 404, error: "archive_not_found", message: msg };
  return { status: 500, error: "internal", message: msg };
}

function summarizeMessage(m: RoomMessage | undefined): { sender: string; senderMemberId?: string; text: string; ts: number } | null {
  if (!m) return null;
  const text = (m.content || "").replace(/\s+/g, " ").trim().slice(0, 140);
  return { sender: m.sender, ...(m.senderMemberId ? {senderMemberId: m.senderMemberId} : {}), text, ts: m.ts };
}

/** Unread/mention for the human user (not member agent cursors). Exported for tests. */
export function countUserUnreadAndMention(
  messages: RoomMessage[],
  cursorId: string | null,
  cursorSeq: number | null,
  userLoginName: string,
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
  // Unread = user-visible chat messages after the user's read cursor.
  // System notices and typed task/knowledge events never badge (Feishu semantics,
  // fish 2026-08-04): they are not conversation the user needs to chase.
  const isUserVisibleChat = (m: RoomMessage): boolean =>
    m.sender !== "user" && m.sender !== "system" && m.type !== "task_event" && m.type !== "knowledge_event" && m.type !== "topic_event";
  const unreadCount = slice.filter(isUserVisibleChat).length;
  // v1 mention approx: text contains @<loginName>
  const needle = userLoginName ? `@${userLoginName}` : "";
  const mentioned = needle
    ? slice.some((m) => isUserVisibleChat(m) && typeof m.content === "string" && m.content.includes(needle))
    : false;
  return { unreadCount, mentioned };
}

function userLoginName(): string {
  try {
    return String((readConfig() as any).username || "").trim();
  } catch {
    return "";
  }
}

// ── Chats (unified conversation list) ──

addRoute("GET", "/api/chats", async (_req, res) => {
  try {
    const members = listMembers();
    const rooms = roomStore.listRooms();
    const login = userLoginName();
    const chats: Array<{
      scopeId: string;
      kind: "dm" | "room";
      title: string;
      lastMessage: { sender: string; senderMemberId?: string; text: string; ts: number } | null;
      unreadCount: number;
      mentioned: boolean;
      status: string;
    }> = [];

    let getScopeLiveStatus: ((scopeId: string) => string) | null = null;
    try {
      const am = await import("../agent/orchestrator/agent-manager.js");
      getScopeLiveStatus = (sid) => am.getScopeLiveStatus(sid);
    } catch {
      getScopeLiveStatus = () => "idle";
    }

    for (const m of members) {
      const scopeId = scopeIdOf({ kind: "dm", memberId: m.id });
      const msgs = readAllDmMessages(m.id);
      const last = msgs[msgs.length - 1];
      const cursor = getUserReadCursor(scopeId);
      const { unreadCount, mentioned } = countUserUnreadAndMention(
        msgs,
        cursor?.messageId ?? null,
        cursor?.seq ?? null,
        login,
      );
      const live = getScopeLiveStatus?.(scopeId) || "idle";
      chats.push({
        scopeId,
        kind: "dm",
        title: m.name,
        lastMessage: summarizeMessage(last),
        unreadCount,
        mentioned,
        status: live === "inactive" ? "idle" : live,
      });
    }

    for (const room of rooms) {
      const scopeId = scopeIdOf({ kind: "room", roomId: room.id });
      const msgs = messageStore.readAllMessages(room.id);
      const last = msgs[msgs.length - 1];
      const cursor = getUserReadCursor(scopeId);
      const { unreadCount, mentioned } = countUserUnreadAndMention(
        msgs,
        cursor?.messageId ?? null,
        cursor?.seq ?? null,
        login,
      );
      const live = getScopeLiveStatus?.(scopeId) || "idle";
      chats.push({
        scopeId,
        kind: "room",
        title: room.name,
        lastMessage: summarizeMessage(last),
        unreadCount,
        mentioned,
        status: live === "inactive" ? "idle" : live,
      });
    }

    chats.sort((a, b) => (b.lastMessage?.ts || 0) - (a.lastMessage?.ts || 0));
    sendJson(res, 200, { chats });
  } catch (err) {
    logger.error("members-api", "chats failed", { error: String(err) });
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

/** Mark a conversation as read for the human user (Chats unread source of truth). */
addRoute("POST", "/api/conversations/:scope/read", async (req, res, params) => {
  try {
    const scopeId = decodeURIComponent(params.scope);
    if (!parseScopeId(scopeId)) {
      sendJson(res, 400, { error: "scope_not_found", message: "invalid scope" });
      return;
    }
    const body = (await parseBody(req)) as { messageId?: string | null; seq?: number | null };
    // Default: advance to latest message in that scope
    let messageId = body.messageId;
    let seq = body.seq;
    if (messageId === undefined && seq === undefined) {
      const ref = parseScopeId(scopeId)!;
      if (ref.kind === "dm") {
        const msgs = readAllDmMessages(ref.memberId);
        const last = msgs[msgs.length - 1];
        messageId = last?.id ?? null;
        seq = typeof last?.seq === "number" ? last.seq : null;
      } else {
        const msgs = messageStore.readAllMessages(ref.roomId);
        const last = msgs[msgs.length - 1];
        messageId = last?.id ?? null;
        seq = typeof last?.seq === "number" ? last.seq : null;
      }
    }
    const cursor = setUserReadCursor(scopeId, { messageId: messageId ?? null, seq: seq ?? null });
    sendJson(res, 200, { scopeId, cursor });
  } catch (err) {
    const msg = String((err as any)?.message || err);
    sendJson(res, msg === "scope_not_found" ? 400 : 500, { error: msg === "scope_not_found" ? "scope_not_found" : "internal", message: msg });
  }
});

// ── Contacts (directory) ──

addRoute("GET", "/api/contacts", async (_req, res) => {
  try {
    const rooms = roomStore.listRooms();
    let getMemberActiveScopes: ((id: string) => string[]) | null = null;
    let getScopeLiveStatus: ((sid: string) => string) | null = null;
    let getMemberLiveStatus: ((id: string) => string) | null = null;
    try {
      const am = await import("../agent/orchestrator/agent-manager.js");
      getMemberActiveScopes = (id) => am.getMemberActiveScopes(id);
      getScopeLiveStatus = (sid) => am.getScopeLiveStatus(sid);
      getMemberLiveStatus = (id) => am.getMemberLiveStatus(id);
    } catch { /* runtime cold */ }

    const contacts = listMembers().map((m) => {
      const membershipScopes: string[] = [];
      // Membership from globalMemberIds (authority); legacy name match only if no global ids on room
      for (const room of rooms) {
        const inGlobal = room.globalMemberIds?.includes(m.id);
        const inLegacy = (!room.globalMemberIds || room.globalMemberIds.length === 0)
          && roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name || rm.sourceMemberId === m.id);
        if (inGlobal || inLegacy) membershipScopes.push(scopeIdOf({ kind: "room", roomId: room.id }));
      }
      membershipScopes.unshift(scopeIdOf({ kind: "dm", memberId: m.id }));

      const workingScopes = getMemberActiveScopes?.(m.id) || [];
      // ① B4: status is member-level — one runtime, one status, every chat.
      const status = getMemberLiveStatus?.(m.id) === "working" ? "working" : "idle";

      return {
        memberId: m.id,
        name: m.name,
        /** database title — replaces template chip on Contacts. */
        title: m.title ?? null,
        agentTemplate: m.agentTemplate,
        status,
        activeScopes: membershipScopes,
        workingScopes,
        model: m.global.model ?? null,
        contextPct: null as number | null,
        tokensToday: 0,
        tokensTotal: 0,
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

addRoute("GET", "/api/members/identities", async (_req, res) => {
  sendJson(res, 200, { members: listMemberIdentities() });
});

addRoute("POST", "/api/members", async (req, res) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      mcpServers?: string[];
    };
    if ("agentTemplate" in body) {
      sendJson(res, 400, { error: "agent_templates_retired", message: "Agent templates are retired; configure the member directly." });
      return;
    }
    // Batch-1 one-click create: name optional → "New Member" (+ suffix).
    const member = createMember({
      name: body.name,
      model: body.model,
      credentialId: body.credentialId,
      thinkingLevel: body.thinkingLevel,
      skills: body.skills,
      mcpServers: body.mcpServers,
      title: (body as { title?: string }).title,
    });
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

/** Item-5 preview (pm 2026-09-02): render the member's actual compiled system
 * prompt for a scope by calling the same compiler with the same arguments the
 * activation points pass — byte-identical to what a real turn injects. */
addRoute("GET", "/api/members/:id/system-prompt", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const scopeParam = url.searchParams.get("scope") || "";
    const ref = parseScopeId(scopeParam);
    if (!scopeParam || !ref) {
      sendJson(res, 400, { error: "scope_not_found", message: "scope query required" });
      return;
    }

    const { previewMemberPrompt } = await import("../app/member-actions.js");
    const { getRoom, resolveRoomMemberRef } = await import("../chat/conversations.js");
    const { getBossmodeDir } = await import("../files/layout.js");
    const { join } = await import("node:path");
    const { buildFinalMemberSystemPrompt } = await import("../agent/prompt/system-prompt-final.js");
    const { memberRecordToConfig, resolveSkills } = await import("../agent/orchestrator/agent-manager.js");
    const { resolveRoomMember } = await import("../member/room-member-resolver.js");
    const { resolveGlobalSkillPaths } = await import("../member/skills.js");

    const respond = (compiled: { fullPrompt: string; agentPrompt: string; appendSystemPrompt: string[]; contractFingerprint: string }, finalArgs: {
      cwd: string;
      member: { id: string; agent: string; model?: string; credentialId?: string; skills?: string[] };
      skillPaths: string[];
    }) => {
      const text = buildFinalMemberSystemPrompt({
        scopeId: scopeParam,
        cwd: finalArgs.cwd,
        member: finalArgs.member as any,
        skillPaths: finalArgs.skillPaths,
        agentPrompt: compiled.agentPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
      });
      sendJson(res, 200, {
        text,
        charCount: text.length,
        scopeId: scopeParam,
        contractFingerprint: compiled.contractFingerprint,
      });
    };

    if (ref.kind === "dm") {
      // DM activation passes room=null + roster-labeled activeScopes, cwd=process.cwd().
      if (ref.memberId !== m.id) {
        sendJson(res, 404, { error: "not_found", message: "scope belongs to another member" });
        return;
      }
      const member = memberRecordToConfig(m.id);
      if (!member) {
        sendJson(res, 404, { error: "not_found", message: "Member not found" });
        return;
      }
      const compiled = previewMemberPrompt(m.id);
      respond(compiled, {
        cwd: activeWorkspaceRoot(m.id),
        member,
        skillPaths: [],
      });
      return;
    }

    // room: roster member config, room cwd, global-skill + extension skill paths.
    const roomId = ref.roomId;
    const room = roomId ? getRoom(roomId) : null;
    const rosterMember = roomId ? resolveRoomMember(roomId, m.id) : null;
    if (!room || !rosterMember || !resolveRoomMemberRef(room.id, m.id)) {
      sendJson(res, 404, { error: "not_found", message: "member not in this room" });
      return;
    }
    const member = rosterMember;
    const skills = resolveSkills(member);
    const skillPaths = [
      ...resolveGlobalSkillPaths(skills),
    ];

    const compiled = previewMemberPrompt(member.id);
    respond(compiled, { cwd: activeWorkspaceRoot(member.id), member, skillPaths });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("PATCH", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      /** database card field (description retired batch-5 — ignored) */
      title?: string | null;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      mcpServers?: string[];
    };
    if ("agentTemplate" in body) {
      sendJson(res, 400, { error: "agent_templates_retired", message: "Agent templates are retired; configure the member directly." });
      return;
    }
    // Single-path model switch (design-model-switch-single-path-v1 §6): the
    // field is either omitted (no change) or a real model ref — null/empty is
    // a parameter error, clearing is not a supported product action.
    if (body.model !== undefined && (body.model === null || !String(body.model).trim())) {
      sendJson(res, 400, { error: "invalid_model", message: "model must be a non-empty model reference; omit the field to leave it unchanged" });
      return;
    }
    let m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const beforeModel = getMemberConfiguration(m.id).model;

    // Model/credential: the one public switch method — validates, applies to
    // every live instance (room+DM) via the SDK, saves config once.
    let modelSwitch: Awaited<ReturnType<typeof switchMemberModel>> | undefined;
    if (body.model !== undefined || body.credentialId !== undefined) {
      const eff = getMemberConfiguration(m.id);
      const targetModel = body.model !== undefined ? String(body.model) : eff.model;
      const targetCred = body.credentialId !== undefined ? (body.credentialId as string | null) : eff.credentialId;
      if (!targetModel || !targetCred) {
        sendJson(res, 400, { error: "invalid_binding", message: "A complete model + credentialId pair is required (model cannot be paired with an empty credential)." });
        return;
      }
      try {
        modelSwitch = await switchMemberModel(m.id, { model: targetModel, credentialId: targetCred });
        // Return the committed record, not the pre-switch object held by this route.
        m = getMember(m.id)!;
      } catch (err: any) {
        if (err && err.name === "MemberModelSwitchConflictError") {
          sendJson(res, 409, { error: "switch_in_progress", message: err.message || String(err) });
        } else {
          sendJson(res, 400, { error: "model_switch_failed", message: err.message || String(err) });
        }
        return;
      }
    }

    let thinkingSwitch: Awaited<ReturnType<typeof switchMemberThinkingLevel>> | undefined;
    if (body.thinkingLevel !== undefined) {
      thinkingSwitch = await switchMemberThinkingLevel(m.id, body.thinkingLevel === null ? "off" : String(body.thinkingLevel));
    }

    if (body.name !== undefined || body.title !== undefined) {
      updateProfileForMember(m.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.title !== undefined ? { title: body.title === null ? "" : body.title } : {}),
      });
    }
    m = getMember(m.id)!;
    // Non-model fields commit in ONE save, and only when there is something to
    // save — a pure model PATCH must not run a second record write after the
    // switch already committed (an unrelated write failure would wrongly fail
    // the whole request after the switch succeeded).
    const globalPatch: { thinkingLevel?: string; skills?: string[]; mcpServers?: string[] } = {};
    if (body.thinkingLevel !== undefined) globalPatch.thinkingLevel = body.thinkingLevel ?? "off";
    if (body.skills !== undefined) globalPatch.skills = body.skills;
    if (body.mcpServers !== undefined) globalPatch.mcpServers = body.mcpServers;
    if (Object.keys(globalPatch).length > 0) {
      m = updateMember(m.id, {
        global: globalPatch,
      });
    }
    sendJson(res, 200, { member: publicMember(m), ...(modelSwitch ? { modelSwitch } : {}), ...(thinkingSwitch ? { thinkingSwitch } : {}) });

    // Birth wake (identity batch-1): model none→some starts the DM instance so
    // the icebreaker can run. Migrated from the retired /config route.
    const afterModel = modelSwitch?.model || beforeModel;
    if (!beforeModel && afterModel) {
      try {
        const { activateDmMember } = await import("../agent/orchestrator/agent-manager.js");
        void activateDmMember(m.id).catch((err) => {
          logger.error("members", "post-config DM activate failed", {
            memberId: m.id,
            error: String((err as Error)?.message || err),
          });
        });
      } catch (err) {
        logger.error("members", "post-config DM activate import failed", {
          memberId: m.id,
          error: String((err as Error)?.message || err),
        });
      }
    }
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
    const result = await archiveMember(m.id, { confirm: !!body.confirm });
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

/** persona.md read-only panel surface (identity batch-2 / designer contract). */
addRoute("GET", "/api/members/:id/profile", async (_req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const { readMemberProfile } = await import("../member/profile.js"); const { memberProfilePath } = await import("../files/layout.js");
    const profile = readMemberProfile(m.id);
    sendJson(res, 200, {
      path: memberProfilePath(m.id),
      body: profile.body,
      charCount: profile.raw.length,
      overBudget: profile.overBudget,
      exists: profile.exists,
    });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

/** Batch 6 §4 read outlet: member-owned asset inventory (designer's Assets tab).
 * mcpServers come from the member's own mcp.json (toolCount only when the
 * availability cache has one — counting tools requires a live connection);
 * extensions use the runtime discovery rules; skills come from the member folder. */
addRoute("GET", "/api/members/:id/assets", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  const config = readMemberMcpConfig(m.id);
  const names = config ? getMcpServerNames(config) : [];
  let cache: Record<string, { toolCount?: number }> = {};
  try {
    cache = readMcpStatusCache() as Record<string, { toolCount?: number }>;
  } catch {
    cache = {};
  }
  const mcpServers = names.map((name) => ({
    name,
    toolCount: typeof cache[name]?.toolCount === "number" ? cache[name].toolCount : null,
  }));

  const extensions = listMemberExtensions(m.id);

  const skills = listMemberSkills(m.id)
    .filter((s) => !s.platform)
    .map((s) => ({ name: s.name, path: s.path, description: s.description }));

  const wsRegistry = readWorkspaces(m.id);
  const active = wsRegistry.active;
  const workspaces = wsRegistry.workspaces.map((w) => ({
    id: w.id,
    kind: w.kind,
    description: w.description,
    root: w.root,
    active: w.id === active,
    ...(w.kind === "ssh" ? { host: w.host, user: w.user } : {}),
  }));
  const sshPublicKey = readMemberSshPublicKey(m.id);

  sendJson(res, 200, { mcpServers, extensions, skills, workspaces, sshPublicKey });
});

/** Member skills/ directory list (reuses skill-catalog scan rules). */
addRoute("GET", "/api/members/:id/skills", async (_req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const { listMemberSkills } = await import("../member/skills.js");
    sendJson(res, 200, { skills: listMemberSkills(m.id) });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id/memory", async (req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const url = new URL(req.url || "", "http://localhost");
    const layer = url.searchParams.get("layer") || "profile";
    // Principles/mainline layers are retired (see GET /api/rooms/:id/principles).
    if (layer === "principles" || layer === "mainline") {
      sendJson(res, 410, { error: "gone", message: "principles/mainline retired — read persona.md via layer=profile" });
      return;
    }
    // "persona" is the historical name of the same file; profile is the live view.
    if (layer !== "profile" && layer !== "persona") {
      sendJson(res, 400, { error: "invalid_layer", message: "layer must be profile" });
      return;
    }
    const { readMemberProfile } = await import("../member/profile.js"); const { memberProfilePath } = await import("../files/layout.js");
    const profile = readMemberProfile(m.id);
    sendJson(res, 200, {
      layer: "profile",
      path: memberProfilePath(m.id),
      content: profile.body,
      raw: profile.raw,
      overBudget: profile.overBudget,
      exists: profile.exists,
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
    const around = url.searchParams.get("around");
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);
    let messages = readAllDmMessages(m.id);
    if (around) {
      // Jump window: center on the referenced message (id or seq).
      const idx = messages.findIndex((msg) => msg.id === around || String(msg.seq) === around);
      if (idx >= 0) {
        const half = Math.floor(Math.min(limit, 100) / 2);
        const start = Math.max(0, idx - half);
        const end = Math.min(messages.length, idx + half + 1);
        messages = messages.slice(start, end);
      } else {
        messages = [];
      }
    } else if (before) {
      const idx = messages.findIndex((msg) => msg.id === before || String(msg.seq) === before);
      if (idx > 0) messages = messages.slice(0, idx);
      if (messages.length > limit) messages = messages.slice(-limit);
    } else if (messages.length > limit) {
      messages = messages.slice(-limit);
    }
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
    const body = (await parseBody(req)) as { text?: string; content?: string; replyTo?: { seq?: number }; attachments?: unknown };
    const text = (body.text ?? body.content ?? "").toString();
    if (!text.trim() && !body.attachments) {
      sendJson(res, 400, { error: "empty", message: "text is required" });
      return;
    }
    // Quote reply in DM scope (plan-reply-to-v1): resolve seq → stable messageId anchor.
    let replyTo: { seq: number; messageId: string } | undefined;
    if (body.replyTo !== undefined && body.replyTo !== null) {
      const seq = Number(body.replyTo.seq);
      if (!Number.isFinite(seq)) { sendJson(res, 400, { error: "replyTo.seq must be a number" }); return; }
      const target = readAllDmMessages(m.id).find((msg) => msg.seq === seq);
      if (!target) { sendJson(res, 404, { error: `Reply target not found: msg:#${seq}` }); return; }
      replyTo = { seq, messageId: target.id };
    }
    const message = postMessage(`dm:${m.id}`,"user",text,[],{
      ...(replyTo ? { replyTo } : {}),
      ...(Array.isArray(body.attachments) ? { attachments: body.attachments as any } : {}),
    });
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
  const scopeId = scopeIdOf({ kind: "dm", memberId: m.id });
  let status: string = "idle";
  let contextPct: number | null = null;
  try {
    const { getAgentStatus, getAgentContextUsage } = await import("../agent/orchestrator/agent-manager.js");
    status = getAgentStatus(scopeId, m.id) || "idle";
    const usage = getAgentContextUsage(scopeId, m.id);
    if (usage && typeof (usage as any).percentage === "number") contextPct = (usage as any).percentage;
  } catch { /* runtime not ready */ }
  sendJson(res, 200, {
    memberId: m.id,
    scopeId,
    status,
    contextPct,
    latestSeq: getLatestDmSeq(m.id),
  });
});
