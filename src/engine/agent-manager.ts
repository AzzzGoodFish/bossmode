// Agent Manager — agent lifecycle management (slimmed down)
// Prompt assembly → engine/prompt-assembler.ts
// Event handling → engine/event-handler.ts
// Tool callbacks → engine/tools.ts

import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { getMemberByName } from "../workforce/member-store.js";
import { getBossmodeDir } from "../shared/config.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as knowledgeStore from "../knowledge/store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { buildAgentPrompt } from "./prompt-assembler.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk, appendEventToDisk } from "./event-handler.js";
import type { RuntimeRegistry } from "./runtime/registry.js";
import type { AgentHandle, AgentStreamEvent, AgentMemberConfig, ContextUsage } from "./runtime/types.js";
import type { AgentStatus, RoomMessage } from "../shared/types.js";

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
      // Summary messages already have agent-friendly content
      if (m.type === "summary") return m.content;
      const sender = m.sender === "user" ? "User" : m.sender;
      return `[${sender}]: ${m.content}`;
    })
    .join("\n\n");
}

// Resolve skills: member config > agent definition > empty
function resolveSkills(member: AgentMemberConfig, agentDef: { skills?: string[] }): string[] {
  return member.skills ?? agentDef.skills ?? [];
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

  const room = roomStore.getRoom(roomId);
  if (!room) {
    logger.error("agent", "room not found", { roomId });
    return null;
  }

  // Find member config — try by name, fall back to auto-create from same-name agent
  let member = getMemberByName(memberName);
  if (!member) {
    const agentDef = loadAgentDefinition(memberName);
    if (!agentDef) {
      logger.error("agent", "no member or agent definition found", { name: memberName });
      return null;
    }
    member = {
      id: memberName,
      name: memberName,
      type: "agent",
      agent: memberName,
      model: agentDef.model || "claude-sonnet-4-6",
      runtime: "pi-cli",
      thinkingLevel: "off",
      avatar: agentDef.avatar,
    };
    logger.info("agent", "loadMember", { member: memberName, source: "auto-default", agent: memberName, runtime: "pi-cli", model: member.model });
  } else {
    logger.info("agent", "loadMember", { member: memberName, source: "members.json", agent: member.agent, runtime: member.runtime, model: member.model });
  }

  const agentDef = loadAgentDefinition(member.agent);
  if (!agentDef) {
    logger.error("agent", "agent definition not found", { member: memberName, agent: member.agent });
    return null;
  }

  const runtime = registry.get(member.runtime);
  if (!runtime) {
    logger.error("agent", "runtime not found", { member: memberName, runtime: member.runtime });
    return null;
  }

  // Load knowledge + rules
  const knowledgeEntries = room.knowledgeBaseId ? knowledgeStore.listEntries(room.knowledgeBaseId, { type: "knowledge" }) : [];

  let rulesPrompt: string | undefined;
  if (room.knowledgeBaseId && room.ruleIds?.length) {
    const rules = room.ruleIds
      .map((id) => knowledgeStore.getEntry(room.knowledgeBaseId!, id))
      .filter(Boolean);
    if (rules.length > 0) {
      rulesPrompt = rules.map((r) => `# ${r!.title}\n\n${r!.content}`).join("\n\n---\n\n");
    }
  }

  const assembled = buildAgentPrompt(agentDef, knowledgeEntries, room.members, memberName);

  // Resolve skills: member config takes precedence over agent definition
  const skills = resolveSkills(member, agentDef);
  const skillPaths = skills.map((s) => join(getBossmodeDir(), "skills", s));

  // Session resume
  const sessions = sessionStore.getSessions(roomId);
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
      agentPrompt: assembled.agentPrompt,
      envPrompt: assembled.envPrompt,
      skillPaths,
      rulesPrompt,
      roomMembers: room.members,
      resumeSession,
      onSessionCreated: (session) => {
        sessionStore.saveSession(roomId, memberName, {
          runtime: member.runtime,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        });
        logger.info("agent", "sessionSaved", { member: memberName, sessionId: session.sessionId, sessionFile: session.sessionFile });
      },
      callbacks: {
        onChat: async (message: string) => {
          postMessage(roomId, memberName, message);
        },
        onMention: async (targetMember: string, message: string) => {
          postMessage(roomId, memberName, message, [targetMember]);
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

    const instance: AgentInstance = {
      handle,
      roomId,
      agentName: memberName,
      status: "idle",
      unsubscribe: () => {},
      eventBuffer: [],
    };

    const unsubscribe = handle.subscribe((event: AgentStreamEvent) => {
      const newStatus = processEvent(roomId, memberName, key, event, instance.eventBuffer);
      if (newStatus) instance.status = newStatus;
    });
    instance.unsubscribe = unsubscribe;

    instances.set(key, instance);
    return instance;
  } catch (err: any) {
    logger.error("agent", `failed to create agent`, { member: memberName, agent: member.agent, runtime: member.runtime, error: err.message || String(err) });
    postMessage(roomId, "system", `Failed to create member "${memberName}" (${member.runtime}): ${err.message || String(err)}`);
    return null;
  }
}

// -- Activation --

export async function activateAgent(roomId: string, memberName: string): Promise<void> {
  logger.info("agent", "activateAgent", { roomId, member: memberName });

  const instance = await getOrCreate(roomId, memberName);
  if (!instance) {
    postMessage(roomId, "system", `Failed to activate member "${memberName}": not found or runtime unavailable.`);
    return;
  }

  const cursors = roomStore.getCursors(roomId);
  const lastCursor = cursors[memberName] ?? null;
  const allNewMessages = getMessagesSince(roomId, lastCursor);
  const latestId = getLatestMessageId(roomId);
  if (latestId) roomStore.updateCursor(roomId, memberName, latestId);
  if (allNewMessages.length === 0) return;

  // Context limit
  const member = getMemberByName(memberName);
  const contextLimit = (member as any)?.contextLimit || 50;
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
      postMessage(roomId, "system", `Member "${memberName}" error: ${err.message || String(err)}`);
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

// -- Context usage --

export async function getAgentContextUsage(roomId: string, agentName: string): Promise<ContextUsage | null> {
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (!instance) return null;
  if (!instance.handle.getContextUsage) return null;
  return instance.handle.getContextUsage();
}

// -- Event history --

export function getAgentEventHistory(roomId: string, agentName: string): AgentStreamEvent[] {
  return loadEventsFromDisk(roomId, agentName);
}

// -- Agent reply (private, user-only) --

export function emitAgentReply(roomId: string, agentName: string, text: string): void {
  const event = { type: "agent_reply" as any, text };
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (instance) instance.eventBuffer.push(event);
  try { appendEventToDisk(roomId, agentName, event); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, error: String(err) }); }
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
  try { appendEventToDisk(roomId, agentName, steerEvent); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, error: String(err) }); }

  // Slash commands (e.g. /compact, /model) are transparently forwarded to the CLI runtime.
  // Only regular text gets the [Private instruction] prefix wrapper.
  const isSlashCommand = instruction.startsWith('/');
  const userMessage = isSlashCommand
    ? instruction
    : `[Private instruction from user]: ${instruction}`;

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

// -- Abort --

export function abortAgent(roomId: string, memberName: string): { ok: boolean; action: string } {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working") return { ok: true, action: "already_idle" };

  // Abort via stdin protocol (both pi-cli and claude-cli), keep instance alive
  instance.handle.abort();
  instance.status = "idle";
  logger.info("agent", "aborted", { member: memberName, roomId });

  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, status: "idle" });
  return { ok: true, action: "aborted" };
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
