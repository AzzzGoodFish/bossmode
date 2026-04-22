// Agent Manager — agent lifecycle management (slimmed down)
// Prompt assembly → engine/prompt-assembler.ts
// Event handling → engine/event-handler.ts
// Tool callbacks → engine/tools.ts

import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { getMemberByName } from "../workforce/member-store.js";
import { getBossmodeDir, readConfig } from "../shared/config.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as knowledgeStore from "../knowledge/store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { buildAgentPrompt } from "./prompt-assembler.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk, appendEventToDisk } from "./event-handler.js";
import {
  wrapPrivateMessage,
  wrapRoomContextMessage,
  wrapRoomMentionMessage,
  resolveSenderRole,
  ROOM_REPLY_FOOTER,
  PRIVATE_REPLY_FOOTER,
} from "./message-envelope.js";
import {
  setActivationSource,
  clearActivationSource,
  clearAllActivationSources,
} from "./activation-context.js";
import { USER_DISPLAY_NAME } from "../shared/user-identity.js";
import type { AgentHistoryEvent } from "./event-handler.js";
import type { RuntimeRegistry } from "./runtime/registry.js";
import type { AgentHandle, AgentStreamEvent, AgentMemberConfig } from "./runtime/types.js";
import type { AgentStatus, RoomMessage, ContextUsage } from "../shared/types.js";

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
  eventBuffer: AgentHistoryEvent[];
}

const instances = new Map<string, AgentInstance>();
const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

function instanceKey(roomId: string, agentName: string): string {
  return `${roomId}:${agentName}`;
}

function transition(
  instance: AgentInstance,
  roomId: string,
  memberName: string,
  newStatus: AgentStatus,
  trigger: string,
): void {
  if (instance.status === newStatus) return;
  const prev = instance.status;
  instance.status = newStatus;
  logger.info("agent", "stateTransition", { member: memberName, from: prev, to: newStatus, trigger });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, status: newStatus });
}

// -- Format messages --

function formatMessagesForAgent(messages: RoomMessage[], receiver: string, roomName: string): string {
  if (messages.length === 0) return "";

  let triggerIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "summary") continue;
    if (Array.isArray(msg.mentions) && msg.mentions.includes(receiver)) {
      triggerIdx = i;
      break;
    }
  }

  if (triggerIdx === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== "summary") {
        triggerIdx = i;
        break;
      }
    }
  }

  const wrapped = messages.map((m, idx) => {
    if (m.type === "summary") return m.content;
    const senderRole = resolveSenderRole(m.sender);
    if (idx === triggerIdx) {
      return wrapRoomMentionMessage(m, roomName, senderRole, receiver);
    }
    return wrapRoomContextMessage(m, roomName, senderRole);
  });

  if (triggerIdx >= 0) wrapped.push(ROOM_REPLY_FOOTER);
  return wrapped.join("\n\n");
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

  const pending = pendingCreations.get(key);
  if (pending) return pending;

  const creation = (async (): Promise<AgentInstance | null> => {
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

    // Load global document tree (injected as index) + active rule docs
    // (injected as full content). The tree is always present; rules depend on
    // what the room explicitly picks via room.ruleDocs.
    const knowledgeEntries = knowledgeStore.listEntries();
    const tree = knowledgeStore.getDocumentTree();

    const ruleDocPaths: string[] = Array.isArray(room.ruleDocs) ? room.ruleDocs : [];

    let rulesPrompt: string | undefined;
    if (ruleDocPaths.length > 0) {
      const rules = ruleDocPaths
        .map((p) => knowledgeStore.getEntry(p))
        .filter(Boolean);
      if (rules.length > 0) {
        rulesPrompt = rules.map((r) => `# ${r!.title}\n\n${r!.content}`).join("\n\n---\n\n");
      }
    }

    const assembled = buildAgentPrompt(agentDef, knowledgeEntries, room.members, room.name, memberName, tree, ruleDocPaths);

    // Resolve skills: member config takes precedence over agent definition
    const skills = resolveSkills(member, agentDef);
    const skillPaths = skills.map((s) => join(getBossmodeDir(), "skills", s));

    // Session resume (global toggle; default true for backward compatibility)
    let sessionResumeEnabled = true;
    try {
      const config = readConfig();
      sessionResumeEnabled = (config.runtime?.sessionResume ?? (config as any).sessionResume) !== false;
    } catch {
      sessionResumeEnabled = true;
    }

    const sessions = sessionStore.getSessions(roomId);
    const savedSession = sessions[memberName];
    const resumeSession = (sessionResumeEnabled && savedSession)
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
        onSessionChanged: (session) => {
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
            // Mention activation is handled by router listener via message-bus.
            postMessage(roomId, memberName, message, [targetMember]);
          },
          onSaveKnowledge: async (title, content) => {
            knowledgeStore.addEntry(title, content, memberName);
          },
          onQueryKnowledge: async (query) => {
            const entries = knowledgeStore.listEntries();
            if (!query) return entries;
            const q = query.toLowerCase();
            return entries.filter((e) => e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
          },
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
        if (newStatus) transition(instance, roomId, memberName, newStatus, event.type);

        // Unexpected CLI exit: notify room and drop dead instance so next mention respawns.
        if (event.type === "runtime_exit" && event.unexpected) {
          const codeStr = event.code !== null ? `exit ${event.code}` : (event.signal ? `signal ${event.signal}` : "terminated");
          const detail = event.stderrTail ? `\n${event.stderrTail}` : "";
          postMessage(roomId, "system", `Member "${memberName}" CLI ${codeStr} unexpectedly.${detail}`);
          logger.warn("agent", "instance removed after unexpected exit", {
            member: memberName, roomId, code: event.code, signal: event.signal,
          });
          if (instances.get(key) === instance) instances.delete(key);
          try { instance.unsubscribe(); } catch {}
          try { handle.destroy(); } catch {}
        }
      });
      instance.unsubscribe = unsubscribe;

      instances.set(key, instance);
      return instance;
    } catch (err: any) {
      logger.error("agent", `failed to create agent`, { member: memberName, agent: member.agent, runtime: member.runtime, error: err.message || String(err) });
      postMessage(roomId, "system", `Failed to create member "${memberName}" (${member.runtime}): ${err.message || String(err)}`);
      return null;
    }
  })();

  pendingCreations.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(key) === creation) pendingCreations.delete(key);
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
  if (latestId) roomStore.setCursor(roomId, memberName, latestId);
  if (allNewMessages.length === 0) return;

  // Context limit
  const member = getMemberByName(memberName);
  const contextLimit = (member as any)?.contextLimit || 50;
  const newMessages = allNewMessages.length > contextLimit
    ? allNewMessages.slice(-contextLimit)
    : allNewMessages;

  logger.info("agent", "incrementalMessages", { member: memberName, count: newMessages.length, total: allNewMessages.length, cursorFrom: lastCursor });

  const formattedMessages = formatMessagesForAgent(newMessages, memberName, roomStore.getRoom(roomId)?.name || roomId);

  const wasWorking = instance.status === "working";
  transition(instance, roomId, memberName, "working", "activate");

  setActivationSource(roomId, memberName, "room_mention");

  if (wasWorking) {
    instance.handle.steer(formattedMessages);
  } else {
    logger.info("agent", "prompt", { member: memberName, messageLength: formattedMessages.length });
    try {
      await instance.handle.prompt(formattedMessages);
    } catch (err: any) {
      logger.error("agent", `prompt error`, { member: memberName, error: err.message || String(err) });
      postMessage(roomId, "system", `Member "${memberName}" error: ${err.message || String(err)}`);
      transition(instance, roomId, memberName, "idle", "activate_prompt_error");
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

// -- Context usage (cache-only API + idle refresh push) --

const contextUsageCache = new Map<string, ContextUsage>();

export function getAgentContextUsage(roomId: string, agentName: string): ContextUsage | null {
  const key = instanceKey(roomId, agentName);
  return contextUsageCache.get(key) ?? null;
}

/** Proactively refresh context usage cache (called on agent_end). Fire-and-forget, non-blocking. */
export function refreshContextUsageOnIdle(roomId: string, agentName: string): void {
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (!instance?.handle.getContextUsage) return;

  instance.handle.getContextUsage().then((usage) => {
    if (!usage) return;
    contextUsageCache.set(key, usage);
    broadcastToRoom(roomId, {
      type: "agent:context_usage",
      roomId,
      agent: agentName,
      usage,
    });
  }).catch(() => {});
}

// -- Event history --

export function getAgentEventHistory(roomId: string, agentName: string): AgentHistoryEvent[] {
  return loadEventsFromDisk(roomId, agentName);
}

function emitAgentLocalEvent(roomId: string, agentName: string, event: AgentHistoryEvent): void {
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

// -- Agent reply (private, user-only) --

export function emitAgentReply(roomId: string, agentName: string, text: string): void {
  emitAgentLocalEvent(roomId, agentName, { type: "agent_reply", text });
}

// -- Steer --

export async function steerAgent(roomId: string, agentName: string, instruction: string): Promise<void> {
  const instance = await getOrCreate(roomId, agentName);
  if (!instance) throw new Error(`Cannot steer agent "${agentName}": not found`);

  const steerEvent: AgentHistoryEvent = { type: "user_steer", text: instruction };
  instance.eventBuffer.push(steerEvent);
  try { appendEventToDisk(roomId, agentName, steerEvent); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, error: String(err) }); }

  // Slash commands (e.g. /compact, /model) are transparently forwarded to the CLI runtime.
  // Only regular text gets wrapped with the private envelope + footer.
  const isSlashCommand = instruction.startsWith('/');
  const userMessage = isSlashCommand
    ? instruction
    : `${wrapPrivateMessage(instruction, USER_DISPLAY_NAME)}\n\n${PRIVATE_REPLY_FOOTER}`;

  setActivationSource(roomId, agentName, isSlashCommand ? "system" : "private_instruction");

  if (instance.status === "working") {
    instance.handle.steer(userMessage);
  } else {
    transition(instance, roomId, agentName, "working", "steer");
    try {
      await instance.handle.prompt(userMessage);
    } catch (err: any) {
      logger.error("agent", "steer error", { agent: agentName, error: err.message || String(err) });
      transition(instance, roomId, agentName, "idle", "steer_prompt_error");
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
  transition(instance, roomId, memberName, "idle", "abort");
  logger.info("agent", "aborted", { member: memberName, roomId });
  return { ok: true, action: "aborted" };
}

// -- Instance management --

export function getMemberInstances(memberName: string): Array<{
  roomId: string;
  roomName: string;
  status: AgentStatus;
  runtime: string;
  pid?: number;
  spawnArgs?: string[];
}> {
  const result: Array<{ roomId: string; roomName: string; status: AgentStatus; runtime: string; pid?: number; spawnArgs?: string[] }> = [];
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
        spawnArgs: handle.spawnArgs,
      });
    }
  }
  return result;
}

export function resetAgentSession(roomId: string, agentName: string): { ok: true; message: string } {
  const sessions = sessionStore.getSessions(roomId);
  const member = getMemberByName(agentName);
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  const runtime = member?.runtime || sessions[agentName]?.runtime || instance?.handle.runtimeName || "pi-cli";

  destroyInstance(roomId, agentName);
  clearActivationSource(roomId, agentName);
  sessionStore.clearSession(roomId, agentName, runtime);
  roomStore.setCursor(roomId, agentName, null);

  const message = "Session reset. Next activation will start fresh.";
  emitAgentLocalEvent(roomId, agentName, { type: "system", text: message });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "inactive" });
  return { ok: true, message };
}

export function destroyInstance(roomId: string, memberName: string): void {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (instance) {
    instance.handle.abort();
    instance.handle.destroy();
    instance.unsubscribe();
    instances.delete(key);
    contextUsageCache.delete(key);
    clearActivationSource(roomId, memberName);
    logger.info("agent", "instance destroyed", { member: memberName, roomId });
  }
  pendingCreations.delete(key);
}

export function getActiveInstanceCount(): number {
  return instances.size;
}

// -- Shutdown --

export async function shutdownAll(): Promise<void> {
  for (const [, instance] of instances) instance.unsubscribe();
  instances.clear();
  pendingCreations.clear();
  contextUsageCache.clear();
  clearAllActivationSources();
  if (registry) {
    for (const rt of registry.getAll()) {
      await rt.shutdownAll().catch((err) => {
        logger.error("agent", "runtime shutdown error", { runtime: rt.name, error: String(err) });
      });
    }
  }
}
