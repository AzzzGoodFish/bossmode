// Workspace API routes — Room, Message, Attachments
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../kernel/logger.js";
import * as roomStore from "../chat/conversations.js";
import * as memberRegistry from "../member/identity.js";
import * as messageStore from "../chat/message-store.js";
import { postMessage } from "../chat/message-bus.js";
import { broadcastToRoom } from "../app/server/ws.js";
import { parseMentionMemberIds, parseMentions } from "../chat/router.js";
import { destroyInstance, abortAgent, compactMember } from "../agent/controls.js";
import { getAgentEventHistory, getRoomAgentStatuses, getAgentContextUsage, getMemberActiveTools, resetAgentSession, persistRoomMemberConfigPatch, broadcastMemberStatus } from "../app/member-actions.js";
import { loadEventsPaginated } from "../agent/events.js";
import { pageActivity as queryActivityPage } from "../data/repositories/event-repository.js";


import { resolveRoomMembers, resolveRoomMember } from "../app/member-actions.js";
import { getModelCredentialProfile } from "../config/models.js";
import { normalizeModelRef, assertModelAvailable } from "../config/models.js";
import * as attachmentStore from "../files/attachment-store.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../files/attachments.js";
import type { RoomMemberConfig, RoomMemberRecord, RoomMessage } from "../kernel/types.js";
import { getAssignableMcpServerNames, parseMcpConfigText, readMcpConfigText } from "../member/mcp.js";

type AttachmentInput = { storedFilename?: string; filename?: string; originalFilename?: string; size?: number };

/** Resolve user-posted attachments against the parent room store. Same shape as room messages. */
function parseUserAttachments(roomId: string, raw: unknown): { ok: true; attachments: RoomMessageAttachment[] } | { ok: false; error: string } {
  const attachments: RoomMessageAttachment[] = [];
  if (!Array.isArray(raw)) return { ok: true, attachments };
  for (const item of raw as AttachmentInput[]) {
    const storedFilename = displayFilename(item?.storedFilename || item?.filename || "");
    if (!storedFilename || !attachmentStore.attachmentExists(roomId, storedFilename)) {
      return { ok: false, error: `Attachment not found: ${storedFilename || "(missing filename)"}` };
    }
    const originalFilename = displayFilename(item?.originalFilename || storedFilename);
    attachments.push({
      id: storedFilename,
      storedFilename,
      originalFilename,
      size: typeof item?.size === "number" ? item.size : undefined,
      previewType: inferAttachmentPreviewType(storedFilename || originalFilename),
    });
  }
  return { ok: true, attachments };
}

// ── Rooms ──

addRoute("GET", "/api/rooms", async (_req, res) => {
  try {
    const rooms = roomStore.listRooms().map((room) => ({
      ...room,
      agentStatuses: getRoomAgentStatuses(room.id),
      agentStale: {},
    }));
    sendJson(res, 200, rooms);
  } catch (err) {
    logger.error("workspace-api", "failed to load Room list", { error: String(err) });
    sendJson(res, 500, { error: "Couldn’t load Rooms" });
  }
});

addRoute("POST", "/api/rooms", async (req, res) => {
  const body = (await parseBody(req)) as {
    name?: string; cwd?: string; memberIds?: unknown; leaderMemberId?: string | null;
    description?: string; ruleDocs?: string[]; docsPath?: string | null;
  };
  if ("principles" in body) {
    sendJson(res, 400, { error: "principles is retired — use description" }); return;
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    sendJson(res, 400, { error: "name is required" }); return;
  }
  if (!Array.isArray(body.memberIds) || body.memberIds.some(id => typeof id !== "string" || !id || id.trim() !== id)) {
    sendJson(res, 400, { error: "memberIds must contain stable member IDs" }); return;
  }
  if ("members" in body || "promptLeaderMemberName" in body) {
    sendJson(res, 400, { error: "Template member drafts are not supported; select existing memberIds" }); return;
  }
  if (body.leaderMemberId != null && (typeof body.leaderMemberId !== "string" || !body.leaderMemberId.trim())) {
    sendJson(res, 400, { error: "leaderMemberId must be a selected member ID" }); return;
  }
  if (body.cwd && !existsSync(body.cwd)) {
    sendJson(res, 400, { error: `Directory does not exist: ${body.cwd}` }); return;
  }
  try {
    const room = roomStore.createRoom(body.name.trim(), body.cwd, body.memberIds as string[], body.ruleDocs, {
      promptLeaderMemberId: body.leaderMemberId ?? undefined, docsPath: body.docsPath,
      description: typeof body.description === "string" ? body.description : undefined,
    });
    sendJson(res, 200, room);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = message.startsWith("Member not found:") ? "member_not_found"
      : message === "leaderMemberId must be one of memberIds" ? "leader_not_in_members" : message;
    sendJson(res, 400, { error, message });
  }
});

addRoute("GET", "/api/rooms/:id", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const agentStatuses = getRoomAgentStatuses(params.id);
  const agentStale = {};
  sendJson(res, 200, { ...room, agentStatuses, agentStale });
});

addRoute("DELETE", "/api/rooms/:id", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  roomStore.deleteRoom(params.id);
  sendJson(res, 200, { ok: true });
});

// Contract drift detection (auto-reload prompt, fish 2026-08-07): list members
// whose stored fingerprint doesn't match the current build.
addRoute("GET", "/api/rooms/:id/contract-drift", async (_req, res) => {
  sendJson(res, 410, { error: "gone", message: "Contract drift / Reload retired" });
});

// Dismiss a contract-drift notification (user clicked "稍后" / "Reset").
addRoute("POST", "/api/rooms/:id/contract-drift/dismiss", async (_req, res) => {
  sendJson(res, 410, { error: "gone", message: "Contract drift / Reload retired" });
});

addRoute("PATCH", "/api/rooms/:id", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const body = (await parseBody(req)) as {
    name?: string;
    cwd?: string;
    description?: string | null;
    ruleDocs?: string[];
    promptLeaderMemberId?: string | null;
    docsPath?: string | null;
  };

  let changed = false;
  let updated = room;

  if (typeof body.name === "string" && body.name.length > 0 && body.name !== room.name) {
    updated = roomStore.updateRoomName(params.id, body.name) || updated;
    changed = true;
  }

  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    try {
      const next = typeof body.description === "string" ? body.description : "";
      if ((room.description ?? "") !== next.trim()) {
        updated = roomStore.updateRoomDescription(params.id, next) || updated;
        changed = true;
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || String(err) });
      return;
    }
  }


  if (Array.isArray(body.ruleDocs)) {
    const current = room.ruleDocs || [];
    const next = body.ruleDocs;
    const sameLength = current.length === next.length;
    const sameItems = sameLength && current.every((v, i) => v === next[i]);
    if (!sameItems) {
      updated = roomStore.updateRoomRuleDocs(params.id, body.ruleDocs) || updated;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "promptLeaderMemberId")) {
    try {
      const nextLeader = body.promptLeaderMemberId ?? null;
      if ((room.promptLeaderMemberId || null) !== nextLeader) {
        updated = roomStore.updateRoomPromptLeader(params.id, nextLeader) || updated;
        changed = true;
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || String(err) });
      return;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "docsPath")) {
    try {
      const nextDocsPath = roomStore.normalizeRoomDocsPath(body.docsPath ?? null) || null;
      if ((room.docsPath || null) !== nextDocsPath) {
        updated = roomStore.updateRoomDocsPath(params.id, body.docsPath ?? null) || updated;
        changed = true;
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || String(err) });
      return;
    }
  }

  if (!changed) {
    sendJson(res, 400, { error: "Nothing to update (provide name, description, cwd, ruleDocs, promptLeaderMemberId, or docsPath)" });
    return;
  }
  sendJson(res, 200, updated);
});

// ── Prompt assets (principles / mainline) — retired serving layer ──
// Q4 decision (record #16636/#20429; confirmed #20991): the dedicated
// principles/mainline serving layer is retired. Historical Markdown and
// revisions stay readable as files/archives; persona lives in persona.md.

// ⑤ A: room principles is retired — the room description (rooms.description,
// name + description) is the room's shared text.
addRoute("GET", "/api/rooms/:id/principles", async (_req, res, _params) => {
  sendJson(res, 410, { error: "gone", message: "Room principles is retired — use the room description (GET /api/rooms/:id)" });
});

addRoute("GET", "/api/rooms/:id/members/:memberRef/principles", async (_req, res, _params) => {
  sendJson(res, 410, { error: "gone", message: "principles/mainline retired — read persona.md via layer=profile" });
});

addRoute("GET", "/api/rooms/:id/members/:memberRef/mainline", async (_req, res, _params) => {
  sendJson(res, 410, { error: "gone", message: "principles/mainline retired — read persona.md via layer=profile" });
});

/** Live active tools for a running member session (getAllTools ∩ active). No session → empty. */
addRoute("GET", "/api/rooms/:id/members/:memberRef/tools", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const member = resolveRoomMember(params.id, params.memberRef);
  if (!member) {
    sendJson(res, 404, { error: "Member is not in this room" });
    return;
  }
  sendJson(res, 200, getMemberActiveTools(params.id, params.memberRef));
});

// ── Messages ──

type ManualCompactCommand =
  | { ok: true; member: RoomMemberRecord }
  | { ok: false; status: number; error: string };

function parseManualCompactCommand(roomId: string, content: string): ManualCompactCommand | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  let targetRef: string | undefined;
  let isCommand = false;

  if (tokens[0] === "/compact") {
    isCommand = true;
    if (tokens.length > 2) return { ok: false, status: 400, error: "Usage: /compact [member] or @member /compact" };
    targetRef = tokens[1];
  } else if (tokens[1] === "/compact" && tokens[0]?.startsWith("@")) {
    isCommand = true;
    if (tokens.length > 2) return { ok: false, status: 400, error: "Usage: /compact [member] or @member /compact" };
    targetRef = tokens[0];
  }

  if (!isCommand) return null;

  const members = roomStore.getRoomMembers(roomId);
  if (!targetRef) {
    if (members.length === 1) return { ok: true, member: members[0] };
    return { ok: false, status: 400, error: "Manual compact requires a target member: /compact @member" };
  }

  const normalizedRef = targetRef.startsWith("@") ? targetRef.slice(1) : targetRef;
  const member = roomStore.resolveRoomMemberRef(roomId, normalizedRef);
  if (!member) return { ok: false, status: 400, error: `Member "${normalizedRef}" is not in this room` };
  return { ok: true, member };
}

addRoute("GET", "/api/rooms/:id/messages", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const before = url.searchParams.get("before") || undefined;
  const around = url.searchParams.get("around") || undefined;

  const messages = messageStore.getMessages(params.id, { limit, before, around });
  sendJson(res, 200, messages);
});

addRoute("POST", "/api/rooms/:id/messages", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const body = (await parseBody(req)) as { content?: string; replyTo?: { seq?: number }; attachments?: Array<{ storedFilename?: string; filename?: string; originalFilename?: string; size?: number }>; artifacts?: string[] };
  const content = typeof body.content === "string" ? body.content : "";
  // Quote reply (plan-reply-to-v1): user sends replyTo.seq; resolve to the stable
  // messageId anchor. Unknown seq = explicit error, never a silent plain message.
  let replyTo: { seq: number; messageId: string } | undefined;
  if (body.replyTo !== undefined && body.replyTo !== null) {
    const seq = Number(body.replyTo.seq);
    if (!Number.isFinite(seq)) { sendJson(res, 400, { error: "replyTo.seq must be a number" }); return; }
    const target = messageStore.readAllMessages(params.id).find((m) => m.seq === seq);
    if (!target) { sendJson(res, 404, { error: `Reply target not found: msg:#${seq}` }); return; }
    replyTo = { seq, messageId: target.id };
  }
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const parsed = parseUserAttachments(params.id, body.attachments);
  if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return; }
  const attachments = parsed.attachments;
  if (!content.trim() && attachments.length === 0 && artifacts.length === 0) {
    sendJson(res, 400, { error: "content, attachments, or artifacts is required" });
    return;
  }

  const compactCommand = parseManualCompactCommand(params.id, content);
  if (compactCommand) {
    if (attachments.length > 0 || artifacts.length > 0) {
      sendJson(res, 400, { error: "Manual compact commands do not support attachments or artifacts" });
      return;
    }
    if (!compactCommand.ok) {
      sendJson(res, compactCommand.status, { error: compactCommand.error });
      return;
    }

    // Store the user's command for transparency, but do not route its textual @mention
    // as a normal model turn. The command itself drives the member event lifecycle.
    postMessage(params.id, "user", content, [], { mentionMemberIds: [] });
    compactMember(`room:${params.id}`, compactCommand.member.id).catch((err) => {
      logger.error("api", "manual compact command failed", { roomId: params.id, memberId: compactCommand.member.id, member: compactCommand.member.name, error: String(err) });
    });

    const messages = messageStore.getMessages(params.id, { limit: 1 });
    const message = messages[messages.length - 1];
    logger.info("api", `POST /api/rooms/:id/messages compact`, { sender: "user", member: compactCommand.member.name, memberId: compactCommand.member.id, roomId: params.id, msgId: message?.id });
    sendJson(res, 200, message);
    return;
  }

  // Parse @ mentions from content (`!name` is plain text — gesture retired 2026-09-11)
  const roomMembers = roomStore.getRoomMembers(params.id);
  const mentions = parseMentions(content, roomMembers.map((member) => member.name));
  const mentionMemberIds = parseMentionMemberIds(content, roomMembers);

  // Post via message-bus (writes + broadcasts + notifies router listeners)
  const extra = {
    mentionMemberIds,
    ...(replyTo ? { replyTo } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
  postMessage(params.id, "user", content, mentions, extra);

  // Return the latest message
  const messages = messageStore.getMessages(params.id, { limit: 1 });
  const message = messages[messages.length - 1];

  logger.info("api", `POST /api/rooms/:id/messages`, { sender: "user", mentions, roomId: params.id, msgId: message?.id });

  sendJson(res, 200, message);
});

// ── Room Members ──

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeRoomModelInput(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? normalizeModelRef(trimmed) : null;
}


addRoute("GET", "/api/rooms/:id/members", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  sendJson(res, 200, resolveRoomMembers(params.id));
});

addRoute("PATCH", "/api/rooms/:id/members/:memberName", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const roomMember = roomStore.resolveRoomMemberRef(params.id, params.memberName);
  if (!roomMember) {
    sendJson(res, 404, { error: "Member is not in this room" });
    return;
  }

  const body = (await parseBody(req)) as { name?: string; model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null; extensions?: string[] | null };
  const patch: { mcpServers?: string[] | null; extensions?: string[] | null } = {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasModel = Object.prototype.hasOwnProperty.call(body, "model");
  const hasCredential = Object.prototype.hasOwnProperty.call(body, "credentialId");
  const hasThinking = Object.prototype.hasOwnProperty.call(body, "thinkingLevel");
  const hasMcpServers = Object.prototype.hasOwnProperty.call(body, "mcpServers");
  const hasExtensions = Object.prototype.hasOwnProperty.call(body, "extensions");

  if (hasMcpServers) {
    if (body.mcpServers === null) patch.mcpServers = null;
    else if (Array.isArray(body.mcpServers)) {
      try {
        const valid = new Set(getAssignableMcpServerNames(parseMcpConfigText(readMcpConfigText())));
        const next = Array.from(new Set(body.mcpServers.map((value) => {
          if (typeof value !== "string") throw new Error("mcpServers must be an array of strings");
          return value.trim();
        }).filter(Boolean)));
        const invalid = next.filter((name) => !valid.has(name));
        if (invalid.length > 0) {
          sendJson(res, 400, { error: `Unknown or invalid MCP server: ${invalid.join(", ")}` });
          return;
        }
        patch.mcpServers = next;
      } catch (err: any) {
        sendJson(res, 400, { error: err.message || String(err) });
        return;
      }
    } else {
      sendJson(res, 400, { error: "mcpServers must be an array of strings or null" });
      return;
    }
  }

  if (hasExtensions) {
    if (body.extensions === null) patch.extensions = null;
    else if (Array.isArray(body.extensions)) {
      try {
        const next = Array.from(new Set(body.extensions.map((value) => {
          if (typeof value !== "string") throw new Error("extensions must be an array of strings");
          return value.trim();
        }).filter(Boolean)));
        // Allow enabling ids that are not currently installed (silent skip at load time).
        patch.extensions = next;
      } catch (err: any) {
        sendJson(res, 400, { error: err.message || String(err) });
        return;
      }
    } else {
      sendJson(res, 400, { error: "extensions must be an array of strings or null" });
      return;
    }
  }

  // Single-path model switch (design-model-switch-single-path-v1 §7): model,
  // credential and thinking are member-global — this room route no longer
  // accepts them. Use PATCH /api/members/:id.
  if (hasModel || hasCredential || hasThinking) {
    sendJson(res, 400, { error: "model_config_is_global", message: "model, credentialId and thinkingLevel are member-global — update them via PATCH /api/members/:id" });
    return;
  }

  if (!hasName && !hasMcpServers && !hasExtensions) {
    sendJson(res, 400, { error: "Nothing to update" });
    return;
  }

  if (hasName) {
    sendJson(res, 400, { error: "member_profile_is_global", message: "name is member-global — update it via PATCH /api/members/:id" });
    return;
  }
  const currentMemberRef = roomMember.id;
  const result: Record<string, unknown> = {};

  if (hasMcpServers || hasExtensions) {
    const roomPatch: { mcpServers?: string[] | null; extensions?: string[] | null } = {};
    if (hasMcpServers) roomPatch.mcpServers = patch.mcpServers;
    if (hasExtensions) roomPatch.extensions = patch.extensions;
    persistRoomMemberConfigPatch(params.id, currentMemberRef, roomPatch);
    broadcastMemberStatus(params.id, currentMemberRef);
  }
  result.member = resolveRoomMember(params.id, currentMemberRef);
  sendJson(res, 200, result);
});

addRoute("POST", "/api/rooms/:id/members", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as { memberId?: string; config?: Partial<RoomMemberConfig> };
  if (typeof body.memberId !== "string" || !body.memberId || body.memberId.trim() !== body.memberId) {
    sendJson(res, 400, { error: "memberId is required" }); return;
  }
  if ("agent" in body || "name" in body) {
    sendJson(res, 400, { error: "Template member drafts are not supported; select an existing memberId" }); return;
  }
  try {
    const { getMember } = await import("../member/identity.js");
    const global = getMember(body.memberId);
    if (!global) { sendJson(res, 404, { error: "Member not found" }); return; }
    const added = roomStore.inviteGlobalMember(params.id, {id: global.id, name: global.name,
      agentTemplate: global.agentTemplate, config: body.config});
    if (!added.ok) {
      sendJson(res, added.code === "duplicate" ? 409 : added.code === "not_found" ? 404 : 400, {error: added.error}); return;
    }
    sendJson(res, 200, roomStore.getRoom(params.id));
  } catch (err) { sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
});

addRoute("DELETE", "/api/rooms/:id/members/:memberRef", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  let globalMemberId: string | undefined;
  try {
    const { resolveMemberRef, findMemberByName } = await import("../member/identity.js");
    if (params.memberRef.startsWith("mem_")) {
      globalMemberId = params.memberRef;
    } else {
      const g = resolveMemberRef(params.memberRef) || findMemberByName(params.memberRef);
      globalMemberId = g?.id;
    }
  } catch { /* ignore */ }

  const removed = roomStore.removeRoomMemberByRef(params.id, params.memberRef, { globalMemberId });
  if (!removed.ok) {
    sendJson(res, 404, { error: removed.error });
    return;
  }
  // Ensure global id cleared even if ref was room-local id
  if (globalMemberId) roomStore.removeGlobalMemberId(params.id, globalMemberId);
  sendJson(res, 200, roomStore.getRoom(params.id));
});

// ── Agent Events & Steer ──

addRoute("GET", "/api/rooms/:id/agents/:agent/events", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get("limit") || "0");
  if (limit > 0) {
    const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!) : undefined;
    const member = roomStore.resolveRoomMemberRef(params.id, params.agent);
    const result = loadEventsPaginated(params.id, member?.id || params.agent, limit, before);
    sendJson(res, 200, result);
  } else {
    // Legacy: return all events (no pagination)
    const events = getAgentEventHistory(params.id, params.agent);
    sendJson(res, 200, events);
  }
});

// Index-backed Activity pagination (0.19.1 S3): query the SQLite activity index
// for a seq window, then O(1) fetch the matching jsonl lines by byte offset —
// no full-file scan. Falls back to the file tail-scan when the projection is
// unavailable so the endpoint always answers.
addRoute("GET", "/api/rooms/:id/members/:ref/events", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const member = roomStore.resolveRoomMemberRef(params.id, params.ref);
  const memberId = member?.id || params.ref;
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 500));
  const beforeSeq = url.searchParams.get("beforeSeq") ? parseInt(url.searchParams.get("beforeSeq")!, 10) : undefined;
  const typesParam = url.searchParams.get("types");
  const types = typesParam ? typesParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  const page = queryActivityPage(params.id, memberId, { beforeSeq, limit, types });
  if (page) {
    sendJson(res, 200, { events: page.events, hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq });
    return;
  }
  // Fallback: legacy tail-based pagination over the file (no seq index).
  const before = beforeSeq;
  const result = loadEventsPaginated(params.id, memberId, limit, before);
  sendJson(res, 200, { events: result.events, hasMore: result.hasMore, nextBeforeSeq: result.hasMore ? Math.max(0, (result.total - result.events.length)) : null });
});

// ── Agent Reload ──

addRoute("POST", "/api/rooms/:id/agents/:agent/reload", async (_req, res) => {
  sendJson(res, 410, { error: "gone", message: "Reload retired — activation recompiles the latest prompt" });
});

// ── Agent Reset ──

addRoute("POST", "/api/rooms/:id/agents/:agent/reset-session", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const member = roomStore.resolveRoomMemberRef(params.id, params.agent);
  if (!member) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const result = resetAgentSession(params.id, member.id);
  logger.info("api", "POST /api/rooms/:id/agents/:agent/reset-session", { agent: params.agent, roomId: params.id });
  sendJson(res, 200, result);
});

// ── Agent Abort ──

addRoute("POST", "/api/rooms/:id/agents/:agent/abort", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const member = roomStore.resolveRoomMemberRef(params.id, params.agent);
  if (!member) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const result = abortAgent(params.id, member.id);
  logger.info("api", "POST /api/rooms/:id/agents/:agent/abort", { agent: params.agent, roomId: params.id, ...result });
  sendJson(res, 200, result);
});

// ── Agent Context Usage ──

addRoute("GET", "/api/rooms/:id/agents/:agent/context-usage", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const member = roomStore.resolveRoomMemberRef(params.id, params.agent);
  if (!member) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const usage = getAgentContextUsage(params.id, member.id);
  if (usage === null) {
    // Cache-only: no data yet (e.g. agent never reached idle)
    sendJson(res, 200, { supported: true, unavailable: true });
  } else {
    sendJson(res, 200, { supported: true, ...usage });
  }
});

// ── Message Range ──

addRoute("GET", "/api/rooms/:id/messages/search", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const opts: messageStore.SearchOptions = {
    query: url.searchParams.get("query") || undefined,
    from: url.searchParams.get("from") || undefined,
    fromMemberId: url.searchParams.get("fromMemberId") || undefined,
    after: url.searchParams.get("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined,
    before: url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined,
    limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
    offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
  };

  const result = messageStore.searchMessages(params.id, opts);
  sendJson(res, 200, result);
});
// Attachment routes moved to src/api/uploads.ts (stream-based)
