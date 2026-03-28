import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { login, requireAuth } from "./auth.js";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinitions, loadAgentDefinition, saveAgentDefinition, deleteAgentDefinition, loadAgentTemplates } from "../store/agent-defs.js";
import { loadSkillDefinitions, loadSkillDefinition, saveSkillDefinition, deleteSkillDefinition, loadSkillTemplates } from "../store/skill-store.js";
import * as knowledgeStore from "../store/knowledge-store.js";
import { loadMembers, getMember, saveMember, deleteMember } from "../store/member-store.js";
import * as roomStore from "../store/room-store.js";
import { broadcastToRoom } from "./ws.js";
import { routeMessage } from "../core/message-router.js";
import { getRoomAgentStatuses, steerAgent, getRegistry, getAgentEventHistory, emitAgentReply, getMemberInstances, destroyInstance } from "../core/agent-manager.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
  });
}

// -- Helpers --

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ============================================================================
// Routes
// ============================================================================

// POST /api/auth/login
addRoute("POST", "/api/auth/login", async (req, res) => {
  const body = (await parseBody(req)) as { username?: string; password?: string };
  if (!body.username || !body.password) {
    sendJson(res, 400, { error: "username and password required" });
    return;
  }
  const result = login(body.username, body.password);
  if (!result) {
    sendJson(res, 401, { error: "Invalid credentials" });
    return;
  }
  sendJson(res, 200, result);
});

// GET /api/capabilities — runtime capabilities
addRoute("GET", "/api/capabilities", async (_req, res) => {
  const reg = getRegistry();
  if (!reg) {
    sendJson(res, 200, { runtimes: {} });
    return;
  }
  sendJson(res, 200, {
    runtimes: reg.getCapabilities(),
  });
});

// ── Agent CRUD ──

// GET /api/agents — list (no systemPrompt)
addRoute("GET", "/api/agents", async (_req, res) => {
  try {
    const agents = loadAgentDefinitions();
    const result = agents.map(({ name, model, description, skills, tags, avatar }) => ({
      name, model, description, skills, tags, avatar,
    }));
    sendJson(res, 200, result);
  } catch {
    sendJson(res, 200, []);
  }
});

// GET /api/agents/templates
addRoute("GET", "/api/agents/templates", async (_req, res) => {
  const templates = loadAgentTemplates();
  const result = templates.map(({ name, model, description, skills, tags, avatar }) => ({
    name, model, description, skills, tags, avatar,
  }));
  sendJson(res, 200, result);
});

// GET /api/agents/:name — detail (with systemPrompt)
addRoute("GET", "/api/agents/:name", async (_req, res, params) => {
  const agent = loadAgentDefinition(params.name);
  if (!agent) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }
  sendJson(res, 200, agent);
});

// POST /api/agents — create (body: { name, content } where content is raw markdown)
addRoute("POST", "/api/agents", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; content?: string };
  if (!body.name || !body.content) {
    sendJson(res, 400, { error: "name and content are required" });
    return;
  }
  // Check name uniqueness
  if (loadAgentDefinition(body.name)) {
    sendJson(res, 409, { error: `Agent "${body.name}" already exists` });
    return;
  }
  const agent = saveAgentDefinition(body.name, body.content);
  sendJson(res, 200, agent);
});

// PUT /api/agents/:name — update
addRoute("PUT", "/api/agents/:name", async (req, res, params) => {
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }
  const agent = saveAgentDefinition(params.name, body.content);
  sendJson(res, 200, agent);
});

// DELETE /api/agents/:name
addRoute("DELETE", "/api/agents/:name", async (_req, res, params) => {
  const deleted = deleteAgentDefinition(params.name);
  if (!deleted) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }
  sendJson(res, 200, { ok: true });
});

// ── Skill CRUD ──

// GET /api/skills
addRoute("GET", "/api/skills", async (_req, res) => {
  try {
    const skills = loadSkillDefinitions();
    const result = skills.map(({ name, description, tags }) => ({ name, description, tags }));
    sendJson(res, 200, result);
  } catch {
    sendJson(res, 200, []);
  }
});

// GET /api/skills/templates
addRoute("GET", "/api/skills/templates", async (_req, res) => {
  const templates = loadSkillTemplates();
  const result = templates.map(({ name, description, tags }) => ({ name, description, tags }));
  sendJson(res, 200, result);
});

// GET /api/skills/:name — detail (with content)
addRoute("GET", "/api/skills/:name", async (_req, res, params) => {
  const skill = loadSkillDefinition(params.name);
  if (!skill) {
    sendJson(res, 404, { error: "Skill not found" });
    return;
  }
  sendJson(res, 200, skill);
});

// POST /api/skills — create
addRoute("POST", "/api/skills", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; content?: string };
  if (!body.name || !body.content) {
    sendJson(res, 400, { error: "name and content are required" });
    return;
  }
  if (loadSkillDefinition(body.name)) {
    sendJson(res, 409, { error: `Skill "${body.name}" already exists` });
    return;
  }
  const skill = saveSkillDefinition(body.name, body.content);
  sendJson(res, 200, skill);
});

// PUT /api/skills/:name — update
addRoute("PUT", "/api/skills/:name", async (req, res, params) => {
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }
  const skill = saveSkillDefinition(params.name, body.content);
  sendJson(res, 200, skill);
});

// DELETE /api/skills/:name
addRoute("DELETE", "/api/skills/:name", async (_req, res, params) => {
  const deleted = deleteSkillDefinition(params.name);
  if (!deleted) {
    sendJson(res, 404, { error: "Skill not found" });
    return;
  }

  // Auto-unbind: remove this skill from all agents that reference it
  try {
    const agents = loadAgentDefinitions();
    for (const agent of agents) {
      if (agent.skills.includes(params.name)) {
        const { getAgentsDir } = await import("../store/agent-defs.js");
        const agentPath = join(getAgentsDir(), `${agent.name}.md`);
        const raw = readFileSync(agentPath, "utf-8");
        const { parseFrontmatter } = await import("../store/frontmatter.js");
        const { meta, body } = parseFrontmatter(raw);
        const skills = Array.isArray(meta.skills) ? (meta.skills as string[]).filter((s) => s !== params.name) : [];
        meta.skills = skills;
        // Rebuild markdown
        const { stringify } = await import("yaml");
        const newContent = `---\n${stringify(meta).trim()}\n---\n\n${body}`;
        saveAgentDefinition(agent.name, newContent);
      }
    }
  } catch (err) {
    logger.error("api", "failed to auto-unbind skill", { error: String(err) });
  }

  sendJson(res, 200, { ok: true });
});

// ── Member CRUD ──

addRoute("GET", "/api/members", async (_req, res) => {
  sendJson(res, 200, loadMembers());
});

addRoute("GET", "/api/members/:id", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, member);
});

addRoute("POST", "/api/members", async (req, res) => {
  const body = (await parseBody(req)) as any;
  if (!body.name || !body.runtime) {
    sendJson(res, 400, { error: "name and runtime are required" });
    return;
  }
  const member = saveMember({
    name: body.name,
    agent: body.agent || "",
    model: body.model || "sonnet",
    runtime: body.runtime,
    thinkingLevel: body.thinkingLevel || "off",
    avatar: body.avatar,
    contextLimit: body.contextLimit,
  });
  sendJson(res, 200, member);
});

addRoute("PUT", "/api/members/:id", async (req, res, params) => {
  const existing = getMember(params.id);
  if (!existing) { sendJson(res, 404, { error: "Member not found" }); return; }
  const body = (await parseBody(req)) as any;
  const member = saveMember({
    id: params.id,
    name: body.name ?? existing.name,
    agent: body.agent ?? existing.agent,
    model: body.model ?? existing.model,
    runtime: body.runtime ?? existing.runtime,
    thinkingLevel: body.thinkingLevel ?? existing.thinkingLevel,
    avatar: body.avatar ?? existing.avatar,
    contextLimit: body.contextLimit ?? existing.contextLimit,
  });
  sendJson(res, 200, member);
});

addRoute("DELETE", "/api/members/:id", async (_req, res, params) => {
  if (!deleteMember(params.id)) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, { ok: true });
});

addRoute("GET", "/api/members/:id/status", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const instances = getMemberInstances(member.name);
  sendJson(res, 200, { instances });
});

addRoute("POST", "/api/members/:id/restart", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  const member = getMember(params.id);
  if (!member || !roomId) { sendJson(res, 400, { error: "member and roomId required" }); return; }
  destroyInstance(roomId, member.name);
  roomStore.saveSession(roomId, member.name, { runtime: member.runtime });
  sendJson(res, 200, { ok: true, message: "Instance destroyed. Will restart on next activation." });
});

// ── Runtimes ──

addRoute("GET", "/api/runtimes", async (_req, res) => {
  const reg = getRegistry();
  if (!reg) { sendJson(res, 200, []); return; }
  const results = [];
  for (const rt of reg.getAll()) {
    const detect = await rt.detect();
    results.push({ name: rt.name, ...detect, capabilities: rt.capabilities });
  }
  sendJson(res, 200, results);
});


// ── Knowledge CRUD ──

addRoute("GET", "/api/knowledge", async (_req, res) => {
  sendJson(res, 200, knowledgeStore.listKnowledgeBases());
});

addRoute("POST", "/api/knowledge", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; description?: string };
  if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }
  const kb = knowledgeStore.createKnowledgeBase(body.name, body.description || "");
  sendJson(res, 200, kb);
});

addRoute("GET", "/api/knowledge/:id", async (_req, res, params) => {
  const kb = knowledgeStore.getKnowledgeBase(params.id);
  if (!kb) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  sendJson(res, 200, kb);
});

addRoute("DELETE", "/api/knowledge/:id", async (_req, res, params) => {
  if (!knowledgeStore.deleteKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  sendJson(res, 200, { ok: true });
});

addRoute("GET", "/api/knowledge/:id/entries", async (req, res, params) => {
  if (!knowledgeStore.getKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  const url = new URL(req.url || "", "http://localhost");
  const type = url.searchParams.get("type") as "rule" | "knowledge" | null;
  sendJson(res, 200, knowledgeStore.listEntries(params.id, type ? { type } : undefined));
});

addRoute("POST", "/api/knowledge/:id/entries", async (req, res, params) => {
  if (!knowledgeStore.getKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  const body = (await parseBody(req)) as { title?: string; content?: string; source?: string; type?: "rule" | "knowledge" };
  if (!body.title || !body.content) { sendJson(res, 400, { error: "title and content are required" }); return; }
  const entry = knowledgeStore.addEntry(params.id, body.title, body.content, body.source || "user", body.type || "knowledge");
  sendJson(res, 200, entry);
});

addRoute("PUT", "/api/knowledge/:id/entries/:eid", async (req, res, params) => {
  const body = (await parseBody(req)) as { title?: string; content?: string };
  if (!body.title || !body.content) { sendJson(res, 400, { error: "title and content are required" }); return; }
  const updated = knowledgeStore.updateEntry(params.id, params.eid, body.title, body.content);
  if (!updated) { sendJson(res, 404, { error: "Entry not found" }); return; }
  sendJson(res, 200, updated);
});

addRoute("DELETE", "/api/knowledge/:id/entries/:eid", async (_req, res, params) => {
  if (!knowledgeStore.deleteEntry(params.id, params.eid)) { sendJson(res, 404, { error: "Entry not found" }); return; }
  sendJson(res, 200, { ok: true });
});

// ── Rooms ──

// GET /api/rooms — list all rooms
addRoute("GET", "/api/rooms", async (_req, res) => {
  const rooms = roomStore.listRooms();
  sendJson(res, 200, rooms);
});

// POST /api/rooms — create room
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

// GET /api/rooms/:id — room details with agent statuses
addRoute("GET", "/api/rooms/:id", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const agentStatuses = getRoomAgentStatuses(params.id);
  sendJson(res, 200, { ...room, agentStatuses });
});

// DELETE /api/rooms/:id — delete room
addRoute("DELETE", "/api/rooms/:id", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  roomStore.deleteRoom(params.id);
  sendJson(res, 200, { ok: true });
});

// PATCH /api/rooms/:id — update room (rename)
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

// GET /api/rooms/:id/messages — get messages with pagination
addRoute("GET", "/api/rooms/:id/messages", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  // Parse query params
  const url = new URL(req.url || "", "http://localhost");
  const limit = parseInt(url.searchParams.get("limit") || "100", 10);
  const before = url.searchParams.get("before") || undefined;

  const messages = roomStore.getMessages(params.id, { limit, before });
  sendJson(res, 200, messages);
});

// POST /api/rooms/:id/messages — send message (user message, parses @ mentions)
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

  const message = roomStore.addMessage(params.id, {
    sender: "user",
    content: body.content,
    mentions,
  });

  logger.info("api", `POST /api/rooms/:id/messages`, { sender: "user", mentions, roomId: params.id, msgId: message.id });

  // Broadcast to room subscribers via WebSocket
  broadcastToRoom(params.id, { type: "room:message", roomId: params.id, message });
  logger.info("ws", "broadcast room:message", { roomId: params.id, msgId: message.id });

  // Route message — activate mentioned agents (async, don't block response)
  routeMessage(params.id, message).catch((err) => {
    logger.error("router", "message routing error", { roomId: params.id, error: String(err) });
  });

  sendJson(res, 200, message);
});

// POST /api/rooms/:id/members — add member to room
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

// GET /api/rooms/:id/agents/:agent/events — agent event history (BUG-008)
addRoute("GET", "/api/rooms/:id/agents/:agent/events", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }
  const events = getAgentEventHistory(params.id, params.agent);
  sendJson(res, 200, events);
});

// POST /api/rooms/:id/agents/:agent/steer — private chat steer injection (F11, F13)
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
    // Fire and forget — steer is async, don't block response
    steerAgent(params.id, params.agent, body.content).catch((err) => {
      logger.error("api", "steer error", { agent: params.agent, roomId: params.id, error: String(err) });
    });
    sendJson(res, 200, { ok: true });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// POST /api/rooms/:id/archive — trigger archive (F14)
addRoute("POST", "/api/rooms/:id/archive", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const result = roomStore.archiveMessages(params.id, 50);
  if (!result) {
    sendJson(res, 200, { message: "Nothing to archive", archivedCount: 0 });
    return;
  }

  // Generate a simple summary (no LLM call for v1 — just a text summary)
  const firstTs = new Date(result.archived[0].ts).toLocaleString();
  const lastTs = new Date(result.archived[result.archived.length - 1].ts).toLocaleString();
  const senders = [...new Set(result.archived.map((m) => m.sender))];
  const summary = `Archived ${result.archived.length} messages from ${firstTs} to ${lastTs}. Participants: ${senders.join(", ")}.`;

  roomStore.saveArchiveSummary(params.id, summary, result.archived, result.timestamp);

  sendJson(res, 200, {
    archivedCount: result.archived.length,
    keptCount: result.kept.length,
    summary,
  });
});

// GET /api/rooms/:id/archives — list archives (F15)
addRoute("GET", "/api/rooms/:id/archives", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) {
    sendJson(res, 404, { error: "Room not found" });
    return;
  }

  const archives = roomStore.listArchives(params.id);
  const result = archives.map((a) => {
    const summary = a.timestamp ? roomStore.readArchiveSummary(params.id, a.timestamp) : null;
    return {
      timestamp: a.timestamp,
      summary: summary?.summary ?? null,
      archivedCount: summary?.archivedCount ?? null,
      range: summary?.range ?? null,
    };
  });

  sendJson(res, 200, result);
});

// GET /api/rooms/:id/archives/:timestamp — get archived messages (F15)
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

  const messages = roomStore.readArchiveMessages(params.id, ts);
  const summary = roomStore.readArchiveSummary(params.id, ts);

  sendJson(res, 200, { messages, summary });
});

// ── Internal Tool Callback (CLI agent tools) ──

addRoute("POST", "/internal/tool-callback", async (req, res) => {
  // No auth — internal only, called by pi extension / claude MCP server
  const body = (await parseBody(req)) as {
    tool?: string; room?: string; agent?: string; params?: Record<string, any>;
  };

  if (!body.tool || !body.room || !body.agent) {
    sendJson(res, 400, { error: "tool, room, agent required" });
    return;
  }

  const { activateAgent } = await import("../core/agent-manager.js");

  logger.info("callback", "tool-callback", { tool: body.tool, room: body.room, agent: body.agent });

  switch (body.tool) {
    case "chat": {
      const mentions: string[] = Array.isArray(body.params?.mentions) ? body.params.mentions : [];
      const target = body.params?.target || "room";

      if (target === "user") {
        // Private reply: don't write to room messages, emit as agent_reply event
        emitAgentReply(body.room, body.agent, body.params?.message || "");
        logger.info("callback", "agent_reply", { roomId: body.room, agent: body.agent });
        sendJson(res, 200, { ok: true, target: "user" });
      } else {
        // Room message: visible to everyone
        const msg = roomStore.addMessage(body.room, {
          sender: body.agent,
          content: body.params?.message || "",
          mentions,
        });
        broadcastToRoom(body.room, { type: "room:message", roomId: body.room, message: msg });
        logger.info("ws", "broadcast room:message", { roomId: body.room, sender: body.agent, msgId: msg.id, mentions });
        for (const t of mentions) {
          activateAgent(body.room, t).catch((err) => {
            logger.error("callback", "mention activate failed", { target: t, error: String(err) });
          });
        }
        sendJson(res, 200, { ok: true });
      }
      break;
    }
    case "mention": {
      // Legacy — redirect to chat with mentions
      const target = body.params?.agent || "";
      const msg = roomStore.addMessage(body.room, {
        sender: body.agent,
        content: body.params?.message || "",
        mentions: [target],
      });
      broadcastToRoom(body.room, { type: "room:message", roomId: body.room, message: msg });
      logger.info("ws", "broadcast room:message", { roomId: body.room, sender: body.agent, msgId: msg.id });
      activateAgent(body.room, target).catch((err) => {
        logger.error("callback", "mention activate failed", { target, error: String(err) });
      });
      sendJson(res, 200, { ok: true });
      break;
    }
    case "query_room_messages": {
      const limit = body.params?.limit || 50;
      const messages = roomStore.getMessages(body.room, { limit });
      const formatted = messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        ts: m.ts,
      }));
      sendJson(res, 200, formatted);
      break;
    }
    case "save_knowledge": {
      const room = roomStore.getRoom(body.room);
      if (room?.knowledgeBaseId) {
        knowledgeStore.addEntry(room.knowledgeBaseId, body.params?.title || "", body.params?.content || "", body.agent);
      }
      sendJson(res, 200, { ok: true });
      break;
    }
    case "query_knowledge": {
      const room = roomStore.getRoom(body.room);
      if (room?.knowledgeBaseId) {
        let entries = knowledgeStore.listEntries(room.knowledgeBaseId);
        if (body.params?.query) {
          const q = body.params.query.toLowerCase();
          entries = entries.filter((e) => e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
        }
        sendJson(res, 200, entries);
      } else {
        sendJson(res, 200, []);
      }
      break;
    }
    default:
      sendJson(res, 400, { error: `Unknown tool: ${body.tool}` });
  }
});

// ============================================================================
// Helpers
// ============================================================================

function parseMentions(content: string, roomMembers: string[]): string[] {
  const mentions: string[] = [];

  // Match @all
  if (/@all\b/.test(content)) {
    return ["all"];
  }

  // Match @agentName
  const atPattern = /@(\w+)/g;
  let match;
  while ((match = atPattern.exec(content)) !== null) {
    const name = match[1];
    if (roomMembers.includes(name)) {
      mentions.push(name);
    }
  }

  return [...new Set(mentions)];
}

// Exported for testing
export { parseMentions };

// ============================================================================
// Router
// ============================================================================

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const rawUrl = req.url || "";
  const method = req.method || "GET";

  if (!rawUrl.startsWith("/api/") && !rawUrl.startsWith("/internal/")) return false;

  // Strip query string for route matching
  const url = rawUrl.split("?")[0];

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Auth check (skip login and internal endpoints)
  if (url !== "/api/auth/login" && !url.startsWith("/internal/") && !requireAuth(req.headers)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = url.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });

    try {
      await route.handler(req, res, params);
    } catch (err: any) {
      logger.error("api", `${method} ${url}`, { error: err.message || String(err) });
      sendJson(res, 500, { error: err.message || "Internal server error" });
    }
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
