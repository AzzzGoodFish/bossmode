// Agent Manager — agent lifecycle, per (room, member) instances
// Uses RuntimeRegistry to select CLI runtime per member
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../store/agent-defs.js";
import { getMemberByName } from "../store/member-store.js";
import { resolveApiKey, getBossmodeDir } from "../store/config.js";
import * as roomStore from "../store/room-store.js";
import * as knowledgeStore from "../store/knowledge-store.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../server/ws.js";
import type { RuntimeRegistry } from "./runtime/registry.js";
import type { AgentHandle, AgentStreamEvent, MemberConfig } from "./runtime/types.js";
import type { AgentDefinition, AgentStatus, RoomMessage, KnowledgeEntry } from "../shared/types.js";

// -- Event persistence (JSONL) --

function agentEventsDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "agent-events");
}

function agentEventsPath(roomId: string, agentName: string): string {
  return join(agentEventsDir(roomId), `${agentName}.jsonl`);
}

function appendEventToDisk(roomId: string, agentName: string, event: AgentStreamEvent | { type: "user_steer"; text: string }): void {
  const dir = agentEventsDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Add timestamp to persisted events
  const withTs = { ...event, ts: Date.now() };
  appendFileSync(agentEventsPath(roomId, agentName), JSON.stringify(withTs) + "\n", "utf-8");
}

function loadEventsFromDisk(roomId: string, agentName: string): AgentStreamEvent[] {
  const path = agentEventsPath(roomId, agentName);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

// -- System Prompt Assembly (5-layer) --

// Build agent-only prompt: Layer 1 (agent def) + Layer 4 (knowledge) + Layer 5 (env)
// Skills and team prompt are passed separately via CreateAgentOpts — each runtime
// decides how to deliver them (pi-cli: --skill + --append-system-prompt; claude-cli: inline)
function buildAgentPrompt(
  agentDef: AgentDefinition,
  knowledgeEntries: KnowledgeEntry[],
  roomMembers: string[],
  memberName?: string,
): string {
  const parts: string[] = [];

  // Layer 1: Agent definition
  parts.push(agentDef.systemPrompt);

  // Layer 4: Knowledge
  if (knowledgeEntries.length > 0) {
    parts.push("---\n\n# Project Knowledge\n");
    for (const entry of knowledgeEntries) {
      parts.push(`## ${entry.title}\n\n${entry.content}\n`);
    }
  }

  // Layer 5: Environment — use memberName as identity, agentDef.name as role
  const identity = memberName || agentDef.name;
  const role = memberName && memberName !== agentDef.name ? agentDef.name : undefined;
  parts.push(buildEnvironmentPrompt(identity, role, roomMembers));

  const fullPrompt = parts.join("\n");
  const agentChars = agentDef.systemPrompt.length;
  const knowledgeChars = knowledgeEntries.reduce((n, e) => n + e.content.length + e.title.length, 0);
  const envChars = fullPrompt.length - agentChars - knowledgeChars;
  logger.info("agent", "assemblePrompt", {
    member: identity, agent: agentDef.name,
    layers: { agent: agentChars, knowledge: knowledgeChars, env: envChars },
    totalTokens: `~${Math.round(fullPrompt.length / 4)}`,
  });

  return fullPrompt;
}

function buildEnvironmentPrompt(memberName: string, role: string | undefined, roomMembers: string[]): string {
  const memberList = roomMembers.join(", ");
  const identity = role ? `"${memberName}" (role: ${role})` : `"${memberName}"`;
  return `
---

## Environment

You are ${identity} in a Bossmode group chat room.
Room members: ${memberList}

## Available Tools

- **chat** — Post a message.
  - \`target: "room"\` (default): visible to everyone in the group chat. **Use this for all normal responses.**
  - \`target: "user"\`: private reply, only the user sees it. **Only use this when responding to [Private instruction from user] messages.**
  - \`mentions\`: optional array of agent names to @activate
- **query_room_messages** — Read recent group chat messages
- **save_knowledge** / **query_knowledge** — Read/write project knowledge base

## Communication Rules

- When activated by an @ mention in the group chat, **always reply with \`target: "room"\`**. Your response should be visible to everyone.
- When you receive a message prefixed with \`[Private instruction from user]\`, reply with \`target: "user"\`. This is a private conversation — do not share it in the group chat.
- Your direct text responses are NOT visible anywhere — only chat tool calls are. Always use the chat tool to communicate.
`;
}

// -- Registry injection --

let registry: RuntimeRegistry | null = null;

export function initAgentManager(reg: RuntimeRegistry): void {
  registry = reg;
}

export function getRegistry(): RuntimeRegistry | null {
  return registry;
}

// -- Instance tracking --

interface AgentInstance {
  handle: AgentHandle;
  roomId: string;
  agentName: string;
  status: AgentStatus;
  unsubscribe: () => void;
  eventBuffer: AgentStreamEvent[];
}

const instances = new Map<string, AgentInstance>();

function instanceKey(roomId: string, agentName: string): string {
  return `${roomId}:${agentName}`;
}

// -- Format messages --

function formatMessagesForAgent(messages: RoomMessage[]): string {
  if (messages.length === 0) return "";
  return messages
    .map((m) => {
      const sender = m.sender === "user" ? "User" : m.sender;
      return `[${sender}]: ${m.content}`;
    })
    .join("\n\n");
}

// -- Instance creation --

async function getOrCreate(roomId: string, memberName: string): Promise<AgentInstance | null> {
  const key = instanceKey(roomId, memberName);
  const existing = instances.get(key);
  if (existing) return existing;

  if (!registry) {
    logger.error("agent", "runtime registry not initialized");
    return null;
  }

  logger.info("agent", "getOrCreate", { member: memberName, roomId, found: false });

  // Load room
  const room = roomStore.getRoom(roomId);
  if (!room) {
    logger.error("agent", "room not found", { roomId });
    return null;
  }

  // Find member config — try by name, fall back to auto-create from same-name agent
  let member = getMemberByName(memberName);
  if (!member) {
    // Auto-create: check if there's an agent definition with this name
    const agentDef = loadAgentDefinition(memberName);
    if (!agentDef) {
      logger.error("agent", "no member or agent definition found", { name: memberName });
      return null;
    }
    member = {
      id: memberName,
      name: memberName,
      agent: memberName,        // same as agent name
      model: agentDef.model,
      runtime: "pi-cli",
      thinkingLevel: "off",
      avatar: agentDef.avatar,
    };
    logger.info("agent", "loadMember", { member: memberName, source: "auto-default", agent: memberName, runtime: "pi-cli", model: agentDef.model });
  } else {
    logger.info("agent", "loadMember", { member: memberName, source: "members.json", agent: member.agent, runtime: member.runtime, model: member.model });
  }

  // Load agent definition via member.agent
  const agentDef = loadAgentDefinition(member.agent);
  if (!agentDef) {
    logger.error("agent", "agent definition not found", { member: memberName, agent: member.agent });
    return null;
  }

  // Get runtime
  const runtime = registry.get(member.runtime);
  if (!runtime) {
    logger.error("agent", "runtime not found", { member: memberName, runtime: member.runtime });
    return null;
  }

  // Load knowledge entries + rules
  const knowledgeEntries = room.knowledgeBaseId ? knowledgeStore.listEntries(room.knowledgeBaseId, { type: "knowledge" }) : [];

  // Build rules prompt from selected rule entries
  let rulesPrompt: string | undefined;
  if (room.knowledgeBaseId && room.ruleIds?.length) {
    const rules = room.ruleIds
      .map((id) => knowledgeStore.getEntry(room.knowledgeBaseId!, id))
      .filter(Boolean);
    if (rules.length > 0) {
      rulesPrompt = rules.map((r) => `# ${r!.title}\n\n${r!.content}`).join("\n\n---\n\n");
    }
  }

  // Build agent-only prompt — use memberName as identity, agentDef.name as role
  const agentPrompt = buildAgentPrompt(agentDef, knowledgeEntries, room.members, memberName);

  // Skill paths from agent definition
  const skillPaths = agentDef.skills.map((s) => join(getBossmodeDir(), "skills", s));

  // Session resume lookup (keyed by memberName)
  const sessions = roomStore.getSessions(roomId);
  const savedSession = sessions[memberName];
  const resumeSession = savedSession
    ? { sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile }
    : undefined;
  if (resumeSession) {
    logger.info("agent", "resumeSession", { member: memberName, runtime: member.runtime, sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile });
  }

  try {
    const handle = await runtime.createAgent({
      cwd: room.cwd,
      roomId,
      member,
      agentPrompt,
      skillPaths,
      rulesPrompt,
      roomMembers: room.members,
      resumeSession,
      onSessionCreated: (session) => {
        roomStore.saveSession(roomId, memberName, {
          runtime: member.runtime,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        });
        logger.info("agent", "sessionSaved", { member: memberName, sessionId: session.sessionId, sessionFile: session.sessionFile });
      },
      callbacks: {
        onChat: async (message: string) => {
          const msg = roomStore.addMessage(roomId, { sender: memberName, content: message, mentions: [] });
          broadcastToRoom(roomId, { type: "room:message", roomId, message: msg });
        },
        onMention: async (targetMember: string, message: string) => {
          const msg = roomStore.addMessage(roomId, { sender: memberName, content: message, mentions: [targetMember] });
          broadcastToRoom(roomId, { type: "room:message", roomId, message: msg });
          activateAgent(roomId, targetMember).catch((err) => {
            logger.error("agent", "mention activate failed", { target: targetMember, roomId, error: String(err) });
          });
        },
        onSaveKnowledge: room.knowledgeBaseId
          ? async (title, content) => { knowledgeStore.addEntry(room.knowledgeBaseId!, title, content, memberName); }
          : undefined,
        onQueryKnowledge: room.knowledgeBaseId
          ? async (query) => {
              const entries = knowledgeStore.listEntries(room.knowledgeBaseId!);
              if (!query) return entries;
              const q = query.toLowerCase();
              return entries.filter((e) => e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
            }
          : undefined,
      },
    });

    logger.info("agent", "agentCreated", { member: memberName, agent: member.agent, runtime: member.runtime, roomId });

    const unsubscribe = handle.subscribe((event: AgentStreamEvent) => {
      handleAgentEvent(roomId, memberName, event);
    });

    const instance: AgentInstance = {
      handle,
      roomId,
      agentName: memberName,
      status: "idle",
      unsubscribe,
      eventBuffer: [],
    };

    instances.set(key, instance);
    return instance;
  } catch (err: any) {
    logger.error("agent", `failed to create agent`, { member: memberName, agent: member.agent, runtime: member.runtime, error: err.message || String(err) });
    const errorMsg = roomStore.addMessage(roomId, {
      sender: "system",
      content: `Failed to create member "${memberName}" (${member.runtime}): ${err.message || String(err)}`,
      mentions: [],
    });
    broadcastToRoom(roomId, { type: "room:message", roomId, message: errorMsg });
    return null;
  }
}

// -- Event handling --

// Accumulate streaming text/thinking so message_end has complete content for persistence
const streamState = new Map<string, { text: string; thinking: string }>();

function handleAgentEvent(roomId: string, agentName: string, event: AgentStreamEvent): void {
  const key = instanceKey(roomId, agentName);

  // Log significant events (skip noisy message_update/tool_update)
  if (event.type === "agent_start" || event.type === "agent_end") {
    logger.info("runtime", "event", { agent: agentName, type: event.type });
  } else if (event.type === "tool_start") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_start", tool: event.toolName });
  } else if (event.type === "tool_end") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_end", tool: event.toolName, isError: !!(event as any).isError });
  }

  // Accumulate text/thinking from message_update
  if (event.type === "message_update") {
    const state = streamState.get(key) || { text: "", thinking: "" };
    if ("text" in event && event.text) state.text += event.text;
    if ("thinking" in event && event.thinking) state.thinking += event.thinking;
    streamState.set(key, state);
  }

  // message_start: clear accumulator
  if (event.type === "message_start") {
    streamState.delete(key);
  }

  // message_end: enrich with accumulated content
  if (event.type === "message_end") {
    const state = streamState.get(key);
    if (state) {
      if (!event.text && state.text) {
        (event as any).text = state.text;
      }
      if (state.thinking) {
        (event as any).thinking = state.thinking;
      }
      streamState.delete(key);
    }
  }

  // Persist non-streaming events to disk (message_end now has complete content)
  if (event.type !== "message_update" && event.type !== "tool_update") {
    const instance = instances.get(key);
    if (instance) instance.eventBuffer.push(event);
    try { appendEventToDisk(roomId, agentName, event); } catch {}
  }

  // WebSocket push — always forward all events including message_update for live streaming
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    event,
  });

  if (event.type === "agent_end") {
    const instance = instances.get(key);
    if (instance) {
      instance.status = "idle";
      logger.info("agent", "statusChange", { agent: agentName, status: "idle" });
      broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "idle" });
    }
  }
}

// -- Activation --

export async function activateAgent(roomId: string, memberName: string): Promise<void> {
  logger.info("agent", "activateAgent", { roomId, member: memberName });

  const instance = await getOrCreate(roomId, memberName);
  if (!instance) {
    const errorMsg = roomStore.addMessage(roomId, {
      sender: "system",
      content: `Failed to activate member "${memberName}": not found or runtime unavailable.`,
      mentions: [],
    });
    broadcastToRoom(roomId, { type: "room:message", roomId, message: errorMsg });
    return;
  }

  const cursors = roomStore.getCursors(roomId);
  const lastCursor = cursors[memberName] ?? null;
  const allNewMessages = roomStore.getMessagesSince(roomId, lastCursor);
  const latestId = roomStore.getLatestMessageId(roomId);
  if (latestId) roomStore.updateCursor(roomId, memberName, latestId);
  if (allNewMessages.length === 0) return;

  // Context limit: cap incremental messages
  const member = getMemberByName(memberName);
  const contextLimit = member?.contextLimit || 50;
  const newMessages = allNewMessages.length > contextLimit
    ? allNewMessages.slice(-contextLimit)
    : allNewMessages;

  logger.info("agent", "incrementalMessages", { member: memberName, count: newMessages.length, total: allNewMessages.length, cursorFrom: lastCursor });

  const formattedMessages = formatMessagesForAgent(newMessages);

  instance.status = "working";
  logger.info("agent", "statusChange", { member: memberName, status: "working" });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, status: "working" });

  if (instance.handle.isWorking) {
    instance.handle.steer(formattedMessages);
  } else {
    logger.info("agent", "prompt", { member: memberName, messageLength: formattedMessages.length });
    try {
      await instance.handle.prompt(formattedMessages);
    } catch (err: any) {
      logger.error("agent", `prompt error`, { member: memberName, error: err.message || String(err) });
      const errorMsg = roomStore.addMessage(roomId, {
        sender: "system",
        content: `Member "${memberName}" error: ${err.message || String(err)}`,
        mentions: [],
      });
      broadcastToRoom(roomId, { type: "room:message", roomId, message: errorMsg });
      instance.status = "idle";
      broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, status: "idle" });
    }
  }
}

// -- @all broadcast --

export async function activateAll(roomId: string): Promise<void> {
  const room = roomStore.getRoom(roomId);
  if (!room) return;
  const activations = room.members.map((agentName) => {
    const key = instanceKey(roomId, agentName);
    const instance = instances.get(key);
    if (instance && instance.status === "working") return Promise.resolve();
    return activateAgent(roomId, agentName);
  });
  await Promise.allSettled(activations);
}

// -- Status --

export function getAgentStatus(roomId: string, agentName: string): AgentStatus {
  const instance = instances.get(instanceKey(roomId, agentName));
  if (!instance) return "inactive";
  return instance.status;
}

export function getRoomAgentStatuses(roomId: string): Record<string, AgentStatus> {
  const room = roomStore.getRoom(roomId);
  if (!room) return {};
  const result: Record<string, AgentStatus> = {};
  for (const m of room.members) result[m] = getAgentStatus(roomId, m);
  return result;
}

// -- Event history --

export function getAgentEventHistory(roomId: string, agentName: string): AgentStreamEvent[] {
  // Always read from disk — disk has complete history across sessions
  return loadEventsFromDisk(roomId, agentName);
}

// -- Agent reply (private, user-only) --

export function emitAgentReply(roomId: string, agentName: string, text: string): void {
  const event = { type: "agent_reply" as any, text };
  // Add to in-memory buffer so getAgentEventHistory includes it
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (instance) instance.eventBuffer.push(event);
  try { appendEventToDisk(roomId, agentName, event); } catch {}
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    event,
  });
}

// -- Steer --

export async function steerAgent(roomId: string, agentName: string, instruction: string): Promise<void> {
  const instance = await getOrCreate(roomId, agentName);
  if (!instance) throw new Error(`Cannot steer agent "${agentName}": not found`);

  const steerEvent = { type: "user_steer" as any, text: instruction };
  instance.eventBuffer.push(steerEvent);
  try { appendEventToDisk(roomId, agentName, steerEvent); } catch {}

  const userMessage = `[Private instruction from user]: ${instruction}`;

  if (instance.handle.isWorking) {
    instance.handle.steer(userMessage);
  } else {
    instance.status = "working";
    broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "working" });
    try {
      await instance.handle.prompt(userMessage);
    } catch (err: any) {
      logger.error("agent", "steer error", { agent: agentName, error: err.message || String(err) });
      instance.status = "idle";
      broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "idle" });
    }
  }
}

// -- Instance management --

export function getMemberInstances(memberName: string): Array<{
  roomId: string;
  roomName: string;
  status: AgentStatus;
  runtime: string;
  pid?: number;
  spawnArgs?: string;
}> {
  const result: Array<{ roomId: string; roomName: string; status: AgentStatus; runtime: string; pid?: number; spawnArgs?: string }> = [];
  for (const [key, instance] of instances) {
    if (key.endsWith(`:${memberName}`)) {
      const roomId = key.split(":")[0];
      const room = roomStore.getRoom(roomId);
      const handle = instance.handle as any;
      result.push({
        roomId,
        roomName: room?.name || roomId,
        status: instance.status,
        runtime: handle.runtimeName || "unknown",
        pid: handle.pid,
        spawnArgs: handle.spawnArgs?.slice(0, 200),
      });
    }
  }
  return result;
}

export function destroyInstance(roomId: string, memberName: string): void {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (instance) {
    if (instance.handle.isWorking) instance.handle.abort();
    instance.handle.destroy();
    instance.unsubscribe();
    instances.delete(key);
    logger.info("agent", "instance destroyed", { member: memberName, roomId });
  }
}

export function getActiveInstanceCount(): number {
  return instances.size;
}

// -- Shutdown --

export async function shutdownAll(): Promise<void> {
  for (const [, instance] of instances) instance.unsubscribe();
  instances.clear();
  if (registry) {
    for (const rt of registry.getAll()) {
      await rt.shutdownAll().catch((err) => {
        logger.error("agent", "runtime shutdown error", { runtime: rt.name, error: String(err) });
      });
    }
  }
}
