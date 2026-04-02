// Workspace API routes — Room, Message, Archive
import { existsSync } from "node:fs";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "../workspace/room-store.js";
import * as messageStore from "../workspace/message-store.js";
import * as archiveStore from "../workspace/archive-store.js";
import { postMessage } from "../communication/message-bus.js";
import { parseMentions } from "../communication/router.js";
import { getRoomAgentStatuses } from "../engine/agent-manager.js";

// ── Rooms ──

addRoute("GET", "/api/rooms", async (_req, res) => {
  const rooms = roomStore.listRooms();
  sendJson(res, 200, rooms);
});

addRoute("POST", "/api/rooms", async (req, res) => {
  const body = (await parseBody(req)) as {
    name?: string; cwd?: string; members?: string[]; knowledgeBaseId?: string; ruleIds?: string[];
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
  const room = roomStore.createRoom(body.name, body.cwd, members, body.knowledgeBaseId, body.ruleIds);
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
  const body = (await parseBody(req)) as { name?: string };
  if (!body.name) {
    sendJson(res, 400, { error: "name is required" });
    return;
  }
  const updated = roomStore.updateRoomName(params.id, body.name);
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

  const messages = messageStore.getMessages(params.id, { limit, before });
  sendJson(res, 200, messages);
});

addRoute("POST", "/api/rooms/:id/messages", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }

  // Parse @ mentions from content
  const mentions = parseMentions(body.content, room.members);

  // Post via message-bus (writes + broadcasts + notifies router listeners)
  postMessage(params.id, "user", body.content, mentions);

  // Return the latest message
  const messages = messageStore.getMessages(params.id, { limit: 1 });
  const message = messages[messages.length - 1];

  logger.info("api", `POST /api/rooms/:id/messages`, { sender: "user", mentions, roomId: params.id, msgId: message?.id });

  sendJson(res, 200, message);
});

// ── Room Members ──

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

import { getAgentEventHistory, steerAgent, abortAgent } from "../engine/agent-manager.js";

addRoute("GET", "/api/rooms/:id/agents/:agent/events", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const events = getAgentEventHistory(params.id, params.agent);
  sendJson(res, 200, events);
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

// ── Archives ──

addRoute("POST", "/api/rooms/:id/archive", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const result = archiveStore.archiveMessages(params.id, 50);
  if (!result) {
    sendJson(res, 200, { message: "Nothing to archive", archivedCount: 0 });
    return;
  }

  const firstTs = new Date(result.archived[0].ts).toLocaleString();
  const lastTs = new Date(result.archived[result.archived.length - 1].ts).toLocaleString();
  const senders = [...new Set(result.archived.map((m) => m.sender))];
  const summary = `Archived ${result.archived.length} messages from ${firstTs} to ${lastTs}. Participants: ${senders.join(", ")}.`;

  archiveStore.saveArchiveSummary(params.id, summary, result.archived, result.timestamp);

  sendJson(res, 200, {
    archivedCount: result.archived.length,
    keptCount: result.kept.length,
    summary,
  });
});

addRoute("GET", "/api/rooms/:id/archives", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const archives = archiveStore.listArchives(params.id);
  const result = archives.map((a) => {
    const summary = a.timestamp ? archiveStore.readArchiveSummary(params.id, a.timestamp) : null;
    return {
      timestamp: a.timestamp,
      summary: summary?.summary ?? null,
      archivedCount: summary?.archivedCount ?? null,
      range: summary?.range ?? null,
    };
  });

  sendJson(res, 200, result);
});

addRoute("GET", "/api/rooms/:id/archives/:timestamp", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const ts = parseInt(params.timestamp, 10);
  if (isNaN(ts)) {
    sendJson(res, 400, { error: "Invalid timestamp" });
    return;
  }

  const messages = archiveStore.readArchiveMessages(params.id, ts);
  const summary = archiveStore.readArchiveSummary(params.id, ts);

  sendJson(res, 200, { messages, summary });
});
