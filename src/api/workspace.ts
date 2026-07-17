// Workspace API routes — Room, Message, Summarize, Attachments
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
import { destroyInstance, getAgentEventHistory, getMemberBusyState, getRoomAgentStatuses, getAgentContextUsage, steerAgent, abortAgent, resetAgentSession, reloadMemberResources, switchMemberModel, switchMemberThinkingLevel } from "../engine/agent-manager.js";
import { loadEventsPaginated } from "../engine/event-handler.js";
import { getSummarizePreview, summarizeRoom, isSummarizing } from "../engine/summarizer.js";
import { readConfig, writeConfig } from "../shared/config.js";
import { resolveRoomMembers, resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getModelCredentialProfile, listAvailableModels, normalizeModelRef, resolveCredentialProfileForModel } from "../engine/model-credentials.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import * as principlesStore from "../workspace/principles-store.js";
import * as mainlineStore from "../workspace/mainline-store.js";
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
    name?: string; cwd?: string; members?: unknown;
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

  if (!Array.isArray(body.members)) {
    sendJson(res, 400, { error: "members must be an array" });
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
    sendJson(res, 200, room);
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
// Writes happen exclusively through member tools (read/edit/write_asset) so governance
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
  const principles = principlesStore.readPrinciplesWithBudget(params.id, "member", member.id);
  sendJson(res, 200, { ...principles, asset: "principles", scope: "member", memberId: member.id, memberName: member.name, budgetHeader: principlesStore.formatBudgetHeader(principles.budget), suggestedTemplate: principles.content.trim() ? undefined : principlesStore.PRINCIPLES_TEMPLATE });
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
  const mainline = mainlineStore.readMainlineWithBudget(params.id, member.id);
  const resolvedContent = mainlineStore.resolveMainlineRefs(params.id, mainline.content);
  sendJson(res, 200, {
    ...mainline,
    content: resolvedContent,
    parsed: mainlineStore.parseMainline(resolvedContent),
    asset: "mainline",
    scope: "member",
    memberId: member.id,
    memberName: member.name,
    budgetHeader: principlesStore.formatBudgetHeader(mainline.budget),
    suggestedTemplate: mainline.content.trim() ? undefined : mainlineStore.MAINLINE_TEMPLATE,
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

  const body = (await parseBody(req)) as { name?: string; model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null };
  const patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null } = {};
  const hasName = Object.prototype.hasOwnProperty.call(body, "name");
  const hasModel = Object.prototype.hasOwnProperty.call(body, "model");
  const hasCredential = Object.prototype.hasOwnProperty.call(body, "credentialId");
  const hasThinking = Object.prototype.hasOwnProperty.call(body, "thinkingLevel");
  const hasMcpServers = Object.prototype.hasOwnProperty.call(body, "mcpServers");

  let model: string | null | undefined;
  if (hasModel) {
    model = normalizeRoomModelInput(body.model);
    if (model) {
      const available = listAvailableModels().some((m) => m.ref === model);
      if (!available) {
        sendJson(res, 400, { error: `Model is not available or credential is missing: ${model}` });
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

  if (!hasName && !hasModel && !hasCredential && !hasThinking && !hasMcpServers) {
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

  if (hasModel || hasCredential || hasThinking || hasMcpServers) {
    roomStore.updateRoomMemberOverride(params.id, currentMemberRef, patch);
  }
  const effective = resolveRoomMember(params.id, currentMemberRef);
  result.member = effective;
  try {
    if (hasModel && effective?.model) result.modelSwitch = await switchMemberModel(params.id, currentMemberRef, effective.model, effective.credentialId);
    if (hasThinking && effective?.thinkingLevel) result.thinkingSwitch = await switchMemberThinkingLevel(params.id, currentMemberRef, effective.thinkingLevel);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
    return;
  }
  sendJson(res, 200, result);
});

addRoute("POST", "/api/rooms/:id/members", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const body = (await parseBody(req)) as { agent?: string; name?: string; config?: Partial<RoomMemberConfig> };
  if (!body.agent) {
    sendJson(res, 400, { error: "agent name is required" });
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

  const updatedRoom = roomStore.getRoom(params.id);
  sendJson(res, 200, updatedRoom);
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

// ── Summarize ──

addRoute("GET", "/api/rooms/:id/summarize/status", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const keepCount = parseInt(url.searchParams.get("keepCount") || "50", 10);
  const preview = getSummarizePreview(params.id, keepCount);
  sendJson(res, 200, preview);
});

addRoute("POST", "/api/rooms/:id/summarize", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const body = (await parseBody(req)) as { keepCount?: number };
  const keepCount = body.keepCount ?? 50;

  if (isSummarizing(params.id)) {
    sendJson(res, 409, { error: "Summarization already in progress" });
    return;
  }

  // Async execution — return 202 immediately
  summarizeRoom(params.id, keepCount).catch((err) => {
    logger.error("api", "summarize failed", { roomId: params.id, error: String(err) });
  });

  sendJson(res, 202, { ok: true, message: "Summarization started" });
});

// ── Message Range (for expanding summaries) ──

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

addRoute("GET", "/api/rooms/:id/messages/range", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!from || !to) {
    sendJson(res, 400, { error: "from and to query parameters are required" });
    return;
  }

  const messages = messageStore.getMessagesByRange(params.id, from, to);
  sendJson(res, 200, messages);
});

// ── Summary Settings ──

addRoute("GET", "/api/settings/summary", async (_req, res) => {
  try {
    const config = readConfig();
    sendJson(res, 200, config.summary || { autoEnabled: false, threshold: 200, keepCount: 50 });
  } catch {
    sendJson(res, 200, { autoEnabled: false, threshold: 200, keepCount: 50 });
  }
});

addRoute("PUT", "/api/settings/summary", async (req, res) => {
  const body = (await parseBody(req)) as { autoEnabled?: boolean; threshold?: number; keepCount?: number };
  try {
    const config = readConfig();
    config.summary = {
      autoEnabled: body.autoEnabled ?? false,
      threshold: body.threshold ?? 200,
      keepCount: body.keepCount ?? 50,
    };
    writeConfig(config);
    sendJson(res, 200, config.summary);
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// Attachment routes moved to src/api/uploads.ts (stream-based)
