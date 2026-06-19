// Workspace API routes — Room, Message, Summarize, Attachments
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "../workspace/room-store.js";
import * as messageStore from "../workspace/message-store.js";
import { postMessage } from "../communication/message-bus.js";
import { parseMentions } from "../communication/router.js";
import { getRoomAgentStatuses, getAgentContextUsage, switchMemberModel, switchMemberThinkingLevel } from "../engine/agent-manager.js";
import { loadEventsPaginated } from "../engine/event-handler.js";
import { getSummarizePreview, summarizeRoom, isSummarizing } from "../engine/summarizer.js";
import { readConfig, writeConfig } from "../shared/config.js";
import { resolveRoomMembers, resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getModelCredentialProfile, listAvailableModels, normalizeModelRef, resolveCredentialProfileForModel } from "../engine/model-credentials.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../shared/attachments.js";

// ── Rooms ──

addRoute("GET", "/api/rooms", async (_req, res) => {
  const rooms = roomStore.listRooms().map((room) => ({
    ...room,
    agentStatuses: getRoomAgentStatuses(room.id),
  }));
  sendJson(res, 200, rooms);
});

addRoute("POST", "/api/rooms", async (req, res) => {
  const body = (await parseBody(req)) as {
    name?: string; cwd?: string; members?: string[];
    ruleDocs?: string[];
  };

  if (!body.name || !body.cwd) {
    sendJson(res, 400, { error: "name and cwd are required" });
    return;
  }

  if (!existsSync(body.cwd)) {
    sendJson(res, 400, { error: `Directory does not exist: ${body.cwd}` });
    return;
  }

  const members = body.members || [];
  const room = roomStore.createRoom(body.name, body.cwd, members, body.ruleDocs);
  sendJson(res, 200, room);
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

  if (!changed) {
    sendJson(res, 400, { error: "Nothing to update (provide name, cwd, or ruleDocs)" });
    return;
  }
  sendJson(res, 200, updated);
});

// ── Messages ──

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

  const body = (await parseBody(req)) as { content?: string; attachments?: Array<{ storedFilename?: string; filename?: string; originalFilename?: string; size?: number }> };
  const content = typeof body.content === "string" ? body.content : "";
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
  if (!content.trim() && attachments.length === 0) {
    sendJson(res, 400, { error: "content or attachments is required" });
    return;
  }

  // Parse @ mentions from content
  const mentions = parseMentions(content, room.members);

  // Post via message-bus (writes + broadcasts + notifies router listeners)
  if (attachments.length > 0) postMessage(params.id, "user", content, mentions, { attachments });
  else postMessage(params.id, "user", content, mentions);

  // Return the latest message
  const messages = messageStore.getMessages(params.id, { limit: 1 });
  const message = messages[messages.length - 1];

  logger.info("api", `POST /api/rooms/:id/messages`, { sender: "user", mentions, roomId: params.id, msgId: message?.id });

  sendJson(res, 200, message);
});

// ── Room Members ──

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
  sendJson(res, 200, resolveRoomMembers(params.id, room.members));
});

addRoute("PATCH", "/api/rooms/:id/members/:memberName", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  if (!room.members.includes(params.memberName)) {
    sendJson(res, 404, { error: "Member is not in this room" });
    return;
  }

  const body = (await parseBody(req)) as { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null };
  const patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null } = {};
  const hasModel = Object.prototype.hasOwnProperty.call(body, "model");
  const hasCredential = Object.prototype.hasOwnProperty.call(body, "credentialId");
  const hasThinking = Object.prototype.hasOwnProperty.call(body, "thinkingLevel");

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
    const credentialTargetModel = model === undefined ? resolveRoomMember(params.id, params.memberName)?.model : model;
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
      sendJson(res, 400, { error: "thinkingLevel must be one of off|minimal|low|medium|high|xhigh" });
      return;
    }
  }

  if (!hasModel && !hasCredential && !hasThinking) {
    sendJson(res, 400, { error: "Nothing to update" });
    return;
  }

  roomStore.updateRoomMemberOverride(params.id, params.memberName, patch);
  const effective = resolveRoomMember(params.id, params.memberName);
  const result: Record<string, unknown> = { member: effective };
  try {
    if (hasModel && effective?.model) result.modelSwitch = await switchMemberModel(params.id, params.memberName, effective.model, effective.credentialId);
    if (hasThinking && effective?.thinkingLevel) result.thinkingSwitch = await switchMemberThinkingLevel(params.id, params.memberName, effective.thinkingLevel);
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

  const body = (await parseBody(req)) as { agent?: string };
  if (!body.agent) {
    sendJson(res, 400, { error: "agent name is required" });
    return;
  }

  const added = roomStore.addMember(params.id, body.agent);
  if (!added) {
    sendJson(res, 409, { error: "Agent is already a member" });
    return;
  }

  const updatedRoom = roomStore.getRoom(params.id);
  sendJson(res, 200, updatedRoom);
});

// ── Agent Events & Steer ──

import { getAgentEventHistory, steerAgent, abortAgent, resetAgentSession } from "../engine/agent-manager.js";

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
    const result = loadEventsPaginated(params.id, params.agent, limit, before);
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

  if (!room.members.includes(params.agent)) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }

  try {
    steerAgent(params.id, params.agent, body.content).catch((err) => {
      logger.error("api", "steer error", { agent: params.agent, roomId: params.id, error: String(err) });
    });
    sendJson(res, 200, { ok: true });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// ── Agent Abort ──

addRoute("POST", "/api/rooms/:id/agents/:agent/reset-session", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  if (!room.members.includes(params.agent)) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const result = resetAgentSession(params.id, params.agent);
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

  if (!room.members.includes(params.agent)) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const result = abortAgent(params.id, params.agent);
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

  if (!room.members.includes(params.agent)) {
    sendJson(res, 400, { error: `Agent "${params.agent}" is not a member of this room` });
    return;
  }

  const usage = getAgentContextUsage(params.id, params.agent);
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
