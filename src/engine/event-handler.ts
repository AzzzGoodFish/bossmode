// Agent event handling — stream accumulation, disk persistence, WS push
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { getBossmodeDir } from "../shared/config.js";
import type { AgentStreamEvent } from "./runtime/types.js";
import type { AgentStatus } from "../shared/types.js";

// -- Event persistence (JSONL) --

function agentEventsDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "agent-events");
}

function agentEventsPath(roomId: string, agentName: string): string {
  return join(agentEventsDir(roomId), `${agentName}.jsonl`);
}

export function appendEventToDisk(roomId: string, agentName: string, event: AgentStreamEvent | { type: "user_steer"; text: string }): void {
  const dir = agentEventsDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const withTs = { ...event, ts: Date.now() };
  appendFileSync(agentEventsPath(roomId, agentName), JSON.stringify(withTs) + "\n", "utf-8");
}

export function loadEventsFromDisk(roomId: string, agentName: string): AgentStreamEvent[] {
  const path = agentEventsPath(roomId, agentName);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

// -- Stream state accumulation --

// Accumulate streaming text/thinking so message_end has complete content
const streamState = new Map<string, { text: string; thinking: string }>();

/**
 * Handle an agent stream event:
 * 1. Accumulate text/thinking from message_update
 * 2. Enrich message_end with accumulated content
 * 3. Persist non-streaming events to disk
 * 4. Push all events via WebSocket
 * 5. Update instance status on agent_end
 *
 * Returns the new status if it changed, undefined otherwise.
 */
export function handleAgentEvent(
  roomId: string,
  agentName: string,
  instanceKey: string,
  event: AgentStreamEvent,
  eventBuffer: AgentStreamEvent[],
): AgentStatus | undefined {
  // Log significant events
  if (event.type === "agent_start" || event.type === "agent_end") {
    logger.info("runtime", "event", { agent: agentName, type: event.type });
  } else if (event.type === "tool_start") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_start", tool: event.toolName });
  } else if (event.type === "tool_end") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_end", tool: event.toolName, isError: !!(event as any).isError });
  }

  // Accumulate text/thinking from message_update
  if (event.type === "message_update") {
    const state = streamState.get(instanceKey) || { text: "", thinking: "" };
    if ("text" in event && event.text) state.text += event.text;
    if ("thinking" in event && event.thinking) state.thinking += event.thinking;
    streamState.set(instanceKey, state);
  }

  if (event.type === "message_start") {
    streamState.delete(instanceKey);
  }

  // message_end: enrich with accumulated content
  if (event.type === "message_end") {
    const state = streamState.get(instanceKey);
    if (state) {
      if (!event.text && state.text) {
        (event as any).text = state.text;
      }
      if (state.thinking) {
        (event as any).thinking = state.thinking;
      }
      streamState.delete(instanceKey);
    }
  }

  // Persist non-streaming events to disk
  if (event.type !== "message_update" && event.type !== "tool_update") {
    eventBuffer.push(event);
    try { appendEventToDisk(roomId, agentName, event); } catch {}
  }

  // WebSocket push — forward all events for live streaming
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    event,
  });

  // Status change on agent_end
  if (event.type === "agent_end") {
    logger.info("agent", "statusChange", { agent: agentName, status: "idle" });
    broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "idle" });
    return "idle";
  }

  return undefined;
}
