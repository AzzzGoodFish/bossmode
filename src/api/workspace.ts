// Workspace API routes — Room, Message, Attachments
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "../workspace/room-store.js";
import * as messageStore from "../workspace/message-store.js";
import * as taskStore from "../workspace/task-store.js";
import { postMessage } from "../communication/message-bus.js";
import { parseMentionMemberIds, parseMentions } from "../communication/router.js";
import { destroyInstance, getAgentEventHistory, getMemberBusyState, getRoomAgentStatuses, getAgentContextUsage, getMemberActiveTools, steerAgent, abortAgent, resetAgentSession, reloadMemberResources, switchMemberModel, switchMemberThinkingLevel } from "../engine/agent-manager.js";
import { loadEventsPaginated } from "../engine/event-handler.js";
import { catchUpActivityIndex, queryActivityPage } from "../workspace/db/activity-index.js";

import { readConfig, writeConfig, getBossmodeDir } from "../shared/config.js";
import { resolveRoomMembers, resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getModelCredentialProfile, normalizeModelRef, resolveCredentialProfileForModel, assertModelAvailable } from "../engine/model-credentials.js";
import { compileMemberPrompt } from "../engine/prompt-compiler.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import * as principlesStore from "../workspace/principles-store.js";
import * as mainlineStore from "../workspace/mainline-store.js";
import { readMemoryLayerInfo } from "../workspace/member-memory-store.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../shared/attachments.js";
import type { CreateRoomMemberInput, RoomMemberConfig, RoomMemberRecord } from "../shared/types.js";
import { getAssignableMcpServerNames, parseMcpConfigText, readMcpConfigText } from "../shared/mcp-settings.js";

// ── Rooms ──

addRoute("GET", "/api/rooms", async (_req, res) => {
  try {
    const rooms = roomStore.listRoomsStrict().map((room) => ({
      ...room,
      agentStatuses: getRoomAgentStatuses(room.id),
    }));
    sendJson(res, 200, rooms);
  } catch (err) {
    logger.error("workspace-api", "failed to load Room list", { error: String(err) });
    sendJson(res, 500, { error: "Couldn’t load Rooms" });
  }
});

addRoute("POST", "/api/rooms", async (req, res) => {
  const body = (await parseBody(req)) as {
    name?: string;
    cwd?: string;
    /** 0.20 contract: global member ids */
    memberIds?: unknown;
    leaderMemberId?: string | null;
    principles?: string;
    /** Legacy until cutover */
    members?: unknown;
    ruleDocs?: string[];
    promptLeaderMemberName?: string;
    docsPath?: string | null;
  };

  if (!body.name || !body.cwd) {
    sendJson(res, 400, { error: "name and cwd are required" });
    return;
  }

  if (!existsSync(body.cwd)) {
    sendJson(res, 400, { error: `Directory does not exist: ${body.cwd}` });
    return;
  }

  // ── 0.20 contract shape: memberIds[] ──
  if (Array.isArray(body.memberIds)) {
    try {
      const { resolveMemberRef, getMember } = await import("../workspace/member-registry.js");
      const ids = body.memberIds.map((v) => String(v || "").trim()).filter(Boolean);
      const globals = [];
      for (const id of ids) {
        const m = resolveMemberRef(id) || getMember(id);
        if (!m) {
          sendJson(res, 400, { error: "member_not_found", message: `Member not found: ${id}` });
          return;
        }
        globals.push(m);
      }
      // Deduplicate by id
      const seen = new Set<string>();
      const unique = globals.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));

      const { loadAgentDefinition } = await import("../workforce/agent-store.js");
      const drafts: CreateRoomMemberInput[] = unique.map((m) => {
        const preferred = (m.agentTemplate || "general").trim() || "general";
        const agent = loadAgentDefinition(preferred) ? preferred : (loadAgentDefinition("general") ? "general" : preferred);
        return { agent, name: m.name };
      });

      let leaderGlobalId =
        typeof body.leaderMemberId === "string" && body.leaderMemberId.trim()
          ? body.leaderMemberId.trim()
          : undefined;
      if (leaderGlobalId && !unique.some((m) => m.id === leaderGlobalId)) {
        sendJson(res, 400, { error: "leader_not_in_members", message: "leaderMemberId must be one of memberIds" });
        return;
      }
      const leaderName = leaderGlobalId
        ? unique.find((m) => m.id === leaderGlobalId)!.name
        : unique[0]?.name;

      // createRoom works with zero members (user manual room) — no team package is materialized.
      let room;
      if (drafts.length === 0) {
        room = roomStore.createRoom(body.name, body.cwd, [], body.ruleDocs, {
          docsPath: body.docsPath,
        });
      } else {
        room = roomStore.createRoom(body.name, body.cwd, drafts, body.ruleDocs, {
          promptLeaderMemberName: leaderName,
          docsPath: body.docsPath,
        });
      }

      // Dual-write globalMemberIds (+ leader global id)
      const globalIds = unique.map((m) => m.id);
      if (!leaderGlobalId && unique[0]) leaderGlobalId = unique[0].id;
      roomStore.stampGlobalMemberIds(room.id, globalIds, leaderGlobalId || null);

      if (typeof body.principles === "string" && body.principles.trim()) {
        principlesStore.writePrinciples({
          roomId: room.id,
          scope: "room",
          content: body.principles,
          actor: { type: "user" },
          reason: "create room",
          operation: "write",
        });
      }

      sendJson(res, 200, roomStore.getRoom(room.id));
      return;
    } catch (err: any) {
      const message = String(err?.message || err);
      sendJson(res, message.startsWith("Agent not found:") ? 404 : 400, { error: message });
      return;
    }
  }

  // ── Legacy shape: members:[{agent,name}] ──
  if (!Array.isArray(body.members)) {
    sendJson(res, 400, { error: "memberIds or members array is required" });
    return;
  }
  if (!body.members.every((member) => member && typeof member === "object" && !Array.isArray(member))) {
    sendJson(res, 400, { error: "members must contain { agent, name } objects" });
    return;
  }
  const members = body.members as CreateRoomMemberInput[];
  if (!members.every((member) => typeof member.agent === "string" && typeof member.name === "string" && member.agent.trim() && member.name.trim())) {
    sendJson(res, 400, { error: "agent and member name are required" });
    return;
  }
  const validation = roomStore.validateRoomMemberNameList(members.map((member) => member.name));
  if (validation) {
    sendJson(res, validation.startsWith("Duplicate") ? 409 : 400, { error: validation });
    return;
  }
  const promptLeaderMemberName = typeof body.promptLeaderMemberName === "string"
    ? roomStore.normalizeMemberName(body.promptLeaderMemberName)
    : "";
  if (!promptLeaderMemberName) {
    sendJson(res, 400, { error: "promptLeaderMemberName is required" });
    return;
  }
  if (!members.some((member) => roomStore.normalizeMemberName(member.name) === promptLeaderMemberName)) {
    sendJson(res, 400, { error: "promptLeaderMemberName must be one of the room members" });
    return;
  }
  try {
    const room = roomStore.createRoom(body.name, body.cwd, members, body.ruleDocs, {
      promptLeaderMemberName,
      docsPath: body.docsPath,
    });
    // Dual-write: stamp global ids when registry has matching names
    try {
      const { findMemberByName } = await import("../workspace/member-registry.js");
      const gids = members
        .map((m) => findMemberByName(m.name)?.id)
        .filter((id): id is string => !!id);
      const leaderG = findMemberByName(promptLeaderMemberName)?.id;
      if (gids.length) roomStore.stampGlobalMemberIds(room.id, gids, leaderG || null);
    } catch { /* ignore */ }
    sendJson(res, 200, roomStore.getRoom(room.id) || room);
  } catch (err: any) {
    const message = String(err?.message || err);
    sendJson(res, message.startsWith("Agent not found:") ? 404 : 400, { error: message });
  }
});

addRoute("GET", "/api/rooms/:id", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const agentStatuses = getRoomAgentStatuses(params.id);
  sendJson(res, 200, { ...room, agentStatuses });
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

addRoute("PATCH", "/api/rooms/:id", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const body = (await parseBody(req)) as {
    name?: string;
    cwd?: string;
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

  if (typeof body.cwd === "string" && body.cwd.length > 0 && body.cwd !== room.cwd) {
    if (!existsSync(body.cwd)) {
      sendJson(res, 400, { error: "Directory does not exist" });
      return;
    }
    updated = roomStore.updateRoomCwd(params.id, body.cwd) || updated;
    changed = true;
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
    sendJson(res, 400, { error: "Nothing to update (provide name, cwd, ruleDocs, promptLeaderMemberId, or docsPath)" });
    return;
  }
  sendJson(res, 200, updated);
});

// ── Prompt Assets: Principles (准则) & Mainline (主线) — read-only public API ──
// Writes happen exclusively through member tools (read/edit/write_memory) so governance
// (reason, budget, history) is enforced in one place.

addRoute("GET", "/api/rooms/:id/principles", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const principles = principlesStore.readPrinciplesWithBudget(params.id, "room");
  sendJson(res, 200, { ...principles, asset: "principles", scope: "room", budgetHeader: principlesStore.formatBudgetHeader(principles.budget), suggestedTemplate: principles.content.trim() ? undefined : principlesStore.PRINCIPLES_TEMPLATE });
});

addRoute("GET", "/api/rooms/:id/members/:memberRef/principles", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const member = roomStore.resolveRoomMemberRef(params.id, params.memberRef);
  if (!member) {
    sendJson(res, 404, { error: "Member is not in this room" });
    return;
  }
  // 0.20: member-level assets live in the member-global memory store (contract §6).
  const info = readMemoryLayerInfo(member.id, "principles", `room:${params.id}`);
  sendJson(res, 200, { ...info, asset: "principles", scope: "member", memberId: member.id, memberName: member.name, budgetHeader: principlesStore.formatBudgetHeader(info.budget), suggestedTemplate: info.content.trim() ? undefined : principlesStore.PRINCIPLES_TEMPLATE });
});

addRoute("GET", "/api/rooms/:id/members/:memberRef/mainline", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const member = roomStore.resolveRoomMemberRef(params.id, params.memberRef);
  if (!member) {
    sendJson(res, 404, { error: "Member is not in this room" });
    return;
  }
  // 0.20: member-level assets live in the member-global memory store (contract §6).
  const info = readMemoryLayerInfo(member.id, "mainline", `room:${params.id}`);
  const resolvedContent = mainlineStore.resolveMainlineRefs(params.id, info.content);
  sendJson(res, 200, {
    ...info,
    content: resolvedContent,
    parsed: mainlineStore.parseMainline(resolvedContent),
    asset: "mainline",
    scope: "member",
    memberId: member.id,
    memberName: member.name,
    budgetHeader: principlesStore.formatBudgetHeader(info.budget),
    suggestedTemplate: info.content.trim() ? undefined : mainlineStore.MAINLINE_TEMPLATE,
  });
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

/** Real, compiled Bossmode Core prompt text for this member in this room —
 * read-only, sourced directly from the same compileMemberPrompt() the runtime
 * uses to build the actual system prompt (never a static/hardcoded preview). */
addRoute("GET", "/api/rooms/:id/members/:memberRef/core-prompt", async (_req, res, params) => {
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
  const agentDef = loadAgentDefinition(member.agent);
  if (!agentDef) {
    sendJson(res, 404, { error: "Agent definition not found for this member" });
    return;
  }
  const docsRoot = join(getBossmodeDir(), "knowledge", "docs");
  const compiled = compileMemberPrompt({ room, member, agentDef, docsRoot });
  const core = compiled.sections.find((s) => s.id === "bossmode-core");
  sendJson(res, 200, {
    content: core?.content || "",
    charCount: core?.charCount ?? 0,
  });
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

  const body = (await parseBody(req)) as { content?: string; attachments?: Array<{ storedFilename?: string; filename?: string; originalFilename?: string; size?: number }>; artifacts?: string[] };
  const content = typeof body.content === "string" ? body.content : "";
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts.map(String).map((value) => value.trim()).filter(Boolean) : [];
  const attachments: RoomMessageAttachment[] = [];
  if (Array.isArray(body.attachments)) {
    for (const raw of body.attachments) {
      const storedFilename = displayFilename(raw?.storedFilename || raw?.filename || "");
      if (!storedFilename || !attachmentStore.attachmentExists(params.id, storedFilename)) {
        sendJson(res, 400, { error: `Attachment not found: ${storedFilename || "(missing filename)"}` });
        return;
      }
      const originalFilename = displayFilename(raw?.originalFilename || storedFilename);
      attachments.push({
        id: storedFilename,
        storedFilename,
        originalFilename,
        size: typeof raw?.size === "number" ? raw.size : undefined,
        previewType: inferAttachmentPreviewType(storedFilename || originalFilename),
      });
    }
  }
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
    steerAgent(params.id, compactCommand.member.id, "/compact").catch((err) => {
      logger.error("api", "manual compact command failed", { roomId: params.id, memberId: compactCommand.member.id, member: compactCommand.member.name, error: String(err) });
    });

    const messages = messageStore.getMessages(params.id, { limit: 1 });
    const message = messages[messages.length - 1];
    logger.info("api", `POST /api/rooms/:id/messages compact`, { sender: "user", member: compactCommand.member.name, memberId: compactCommand.member.id, roomId: params.id, msgId: message?.id });
    sendJson(res, 200, message);
    return;
  }

  // Parse @ mentions from content
  const roomMembers = roomStore.getRoomMembers(params.id);
  const mentions = parseMentions(content, roomMembers.map((member) => member.name));
  const mentionMemberIds = parseMentionMemberIds(content, roomMembers);

  // Post via message-bus (writes + broadcasts + notifies router listeners)
  const extra = { mentionMemberIds, ...(attachments.length > 0 ? { attachments } : {}), ...(artifacts.length > 0 ? { artifacts } : {}) };
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

function validateCredentialMatchesModel(credentialId: unknown, model: string | null | undefined): string | null | undefined {
  if (credentialId === null || credentialId === "") return null;
  if (credentialId === undefined) return undefined;
  if (typeof credentialId !== "string") throw new Error("credentialId must be a string");
  if (!model) throw new Error("credentialId requires an explicit model override");
  const credential = getModelCredentialProfile(credentialId);
  if (!credential) throw new Error("Model credential profile not found");
  if (!credential.enabled) throw new Error("Model credential profile is disabled");
  resolveCredentialProfileForModel({ modelRef: model, credentialId });
  return credentialId;
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
  const patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null; extensions?: string[] | null } = {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasModel = Object.prototype.hasOwnProperty.call(body, "model");
  const hasCredential = Object.prototype.hasOwnProperty.call(body, "credentialId");
  const hasThinking = Object.prototype.hasOwnProperty.call(body, "thinkingLevel");
  const hasMcpServers = Object.prototype.hasOwnProperty.call(body, "mcpServers");
  const hasExtensions = Object.prototype.hasOwnProperty.call(body, "extensions");

  let model: string | null | undefined;
  if (hasModel) {
    model = normalizeRoomModelInput(body.model);
    if (model) {
      try {
        assertModelAvailable(model, "PATCH room member model");
      } catch (err: any) {
        sendJson(res, 400, { error: err.message || String(err) });
        return;
      }
    }
    patch.model = model ?? null;
  }

  try {
    const credentialTargetModel = model === undefined ? resolveRoomMember(params.id, roomMember.id)?.model : model;
    const credentialId = hasCredential ? validateCredentialMatchesModel(body.credentialId, credentialTargetModel) : undefined;
    if (hasCredential) patch.credentialId = credentialId ?? null;
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
    return;
  }

  if (hasThinking) {
    if (body.thinkingLevel === null || body.thinkingLevel === "") patch.thinkingLevel = null;
    else if (typeof body.thinkingLevel === "string" && THINKING_LEVELS.has(body.thinkingLevel)) patch.thinkingLevel = body.thinkingLevel;
    else {
      sendJson(res, 400, { error: "thinkingLevel must be one of off|minimal|low|medium|high|xhigh|max" });
      return;
    }
  }

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

  if (!hasName && !hasModel && !hasCredential && !hasThinking && !hasMcpServers && !hasExtensions) {
    sendJson(res, 400, { error: "Nothing to update" });
    return;
  }

  let currentMemberRef = roomMember.id;
  const result: Record<string, unknown> = {};
  if (hasName) {
    if (typeof body.name !== "string") {
      sendJson(res, 400, { error: "name must be a string" });
      return;
    }
    const busy = getMemberBusyState(params.id, roomMember.id);
    if (busy.busy) {
      sendJson(res, 409, { error: `Cannot rename a busy member (${busy.reason || "busy"}). Stop or wait for it to become idle first.` });
      return;
    }
    const oldName = roomMember.name;
    const renamed = roomStore.renameRoomMember(params.id, roomMember.id, body.name);
    if (!renamed.ok) {
      sendJson(res, renamed.code === "duplicate" ? 409 : 400, { error: renamed.error });
      return;
    }
    currentMemberRef = renamed.member.id;
    destroyInstance(params.id, renamed.member.id);
    result.renamed = true;
    result.taskReferencesUpdated = taskStore.renameParticipant(params.id, { memberId: renamed.member.id, oldName, newName: renamed.member.name });
  }

  if (hasThinking || hasMcpServers || hasExtensions) {
    // Non-model fields commit immediately. Model/credential go through
    // switchMemberModel so the live instance is updated before room.json.
    const nonModelPatch: { thinkingLevel?: string | null; mcpServers?: string[] | null; extensions?: string[] | null } = {};
    if (hasThinking) nonModelPatch.thinkingLevel = patch.thinkingLevel;
    if (hasMcpServers) nonModelPatch.mcpServers = patch.mcpServers;
    if (hasExtensions) nonModelPatch.extensions = patch.extensions;
    roomStore.updateRoomMemberOverride(params.id, currentMemberRef, nonModelPatch);
  }
  try {
    if (hasModel || hasCredential) {
      const current = resolveRoomMember(params.id, currentMemberRef);
      const targetModel = hasModel ? (patch.model ?? null) : (current?.model ?? null);
      const targetCred = hasCredential ? (patch.credentialId ?? null) : (current?.credentialId ?? null);
      if (targetModel) {
        result.modelSwitch = await switchMemberModel(params.id, currentMemberRef, targetModel, targetCred);
      } else {
        // Clearing the model binding — no live switch to apply.
        roomStore.updateRoomMemberOverride(params.id, currentMemberRef, { model: null, credentialId: null });
      }
    }
    if (hasThinking) {
      const effectiveThinking = resolveRoomMember(params.id, currentMemberRef);
      if (effectiveThinking?.thinkingLevel) {
        result.thinkingSwitch = await switchMemberThinkingLevel(params.id, currentMemberRef, effectiveThinking.thinkingLevel);
      }
    }
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
    return;
  }
  result.member = resolveRoomMember(params.id, currentMemberRef);
  sendJson(res, 200, result);
});

addRoute("POST", "/api/rooms/:id/members", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const body = (await parseBody(req)) as {
    memberId?: string;
    agent?: string;
    name?: string;
    config?: Partial<RoomMemberConfig>;
  };

  // 0.20: invite by global memberId (preferred)
  if (typeof body.memberId === "string" && body.memberId.trim()) {
    try {
      const { resolveMemberRef } = await import("../workspace/member-registry.js");
      const global = resolveMemberRef(body.memberId.trim());
      if (!global) {
        sendJson(res, 404, { error: "Member not found" });
        return;
      }
      const added = roomStore.inviteGlobalMember(params.id, {
        id: global.id,
        name: global.name,
        agentTemplate: global.agentTemplate,
        config: body.config,
      });
      if (!added.ok) {
        sendJson(res, added.code === "duplicate" ? 409 : added.code === "not_found" ? 404 : 400, { error: added.error });
        return;
      }
      sendJson(res, 200, roomStore.getRoom(params.id));
      return;
    } catch (err: any) {
      sendJson(res, 400, { error: err?.message || String(err) });
      return;
    }
  }

  // Legacy: invite by agent template + local member name
  if (!body.agent) {
    sendJson(res, 400, { error: "memberId or agent name is required" });
    return;
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    sendJson(res, 400, { error: "member name is required" });
    return;
  }

  const added = roomStore.addRoomMemberFromAgent(params.id, { agentName: body.agent, memberName: body.name, config: body.config });
  if (!added.ok) {
    sendJson(res, added.code === "duplicate" ? 409 : added.code === "not_found" ? 404 : 400, { error: added.error });
    return;
  }

  // Dual-write: if a global member with this name exists, stamp id
  try {
    const { findMemberByName } = await import("../workspace/member-registry.js");
    const g = findMemberByName(body.name);
    if (g) roomStore.addGlobalMemberId(params.id, g.id);
  } catch { /* ignore */ }

  const updatedRoom = roomStore.getRoom(params.id);
  sendJson(res, 200, updatedRoom);
});

// 0.20: remove member from room (keeps their scope memory assets)
addRoute("DELETE", "/api/rooms/:id/members/:memberRef", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  let globalMemberId: string | undefined;
  try {
    const { resolveMemberRef, findMemberByName } = await import("../workspace/member-registry.js");
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

  // Self-heal any index gap for this member before serving (tail beyond wm).
  catchUpActivityIndex(params.id, memberId);
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

addRoute("POST", "/api/rooms/:id/agents/:agent/steer", async (req, res, params) => {
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

  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }

  try {
    steerAgent(params.id, member.id, body.content).catch((err) => {
      logger.error("api", "steer error", { agent: params.agent, roomId: params.id, error: String(err) });
    });
    sendJson(res, 200, { ok: true });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// ── Agent Reload ──

addRoute("POST", "/api/rooms/:id/agents/:agent/reload", async (_req, res, params) => {
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

  try {
    const result = await reloadMemberResources(params.id, member.id);
    logger.info("api", "POST /api/rooms/:id/agents/:agent/reload", { agent: params.agent, roomId: params.id, reloaded: result.reloaded });
    sendJson(res, 200, result);
  } catch (err: any) {
    logger.warn("api", "member reload failed", { agent: params.agent, roomId: params.id, error: err.message || String(err) });
    sendJson(res, 409, { error: err.message || String(err) });
  }
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
    after: url.searchParams.get("after") ? parseInt(url.searchParams.get("after")!, 10) : undefined,
    before: url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!, 10) : undefined,
    limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
    offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined,
  };

  const result = messageStore.searchMessages(params.id, opts);
  sendJson(res, 200, result);
});
// Attachment routes moved to src/api/uploads.ts (stream-based)
