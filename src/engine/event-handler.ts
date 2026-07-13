// Agent event handling — stream accumulation, disk persistence, WS push
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { broadcastToAgentSubscribers } from "../communication/ws.js";
import { getBossmodeDir } from "../shared/config.js";
import { refreshContextUsage } from "./agent-manager.js";
import { maybeEmitKnowledgeActivity } from "./knowledge-activity.js";
import { getRoom } from "../workspace/room-store.js";
import type { AgentStreamEvent } from "./runtime/types.js";
import type { AgentStatus } from "../shared/types.js";

export type AgentHistoryEvent =
  | AgentStreamEvent
  | { type: "user_steer"; text: string; ts?: number }
  | { type: "agent_reply"; text: string; ts?: number }
  | { type: "system"; text: string; ts?: number };

// -- Event persistence (JSONL) --

function agentEventsDir(roomId: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "agent-events");
}

function agentEventsPath(roomId: string, agentName: string): string {
  return join(agentEventsDir(roomId), `${agentName}.jsonl`);
}

export function appendEventToDisk(roomId: string, agentRef: string, event: AgentHistoryEvent): void {
  const dir = agentEventsDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const withTs = { ...event, ts: Date.now() };
  appendFileSync(agentEventsPath(roomId, agentRef), JSON.stringify(withTs) + "\n", "utf-8");
}

export function loadEventsFromDisk(roomId: string, agentRef: string): AgentHistoryEvent[] {
  const path = agentEventsPath(roomId, agentRef);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

/** Load events with tail-based pagination. Returns { events, total, hasMore }. */
export function loadEventsPaginated(roomId: string, agentRef: string, limit: number, before?: number): { events: AgentHistoryEvent[]; total: number; hasMore: boolean } {
  const all = loadEventsFromDisk(roomId, agentRef);
  const total = all.length;
  const endIdx = before !== undefined ? Math.min(before, total) : total;
  const startIdx = Math.max(0, endIdx - limit);
  return { events: all.slice(startIdx, endIdx), total, hasMore: startIdx > 0 };
}

// -- Stream state accumulation --

// Accumulate streaming text/thinking so message_end has complete content
const toolArgsCache = new Map<string, unknown>();

const streamState = new Map<string, { text: string; thinking: string }>();

/**
 * Handle an agent stream event:
 * 1. Accumulate text/thinking from message_update
 * 2. Enrich message_end with accumulated content
 * 3. Persist non-streaming events to disk
 * 4. Push all events via WebSocket
 * 5. Update public instance status from runtime agent_start/agent_end
 *
 * Returns the new status if it changed, undefined otherwise.
 */
export function handleAgentEvent(
  roomId: string,
  agentName: string,
  instanceKey: string,
  event: AgentStreamEvent,
  eventBuffer: AgentHistoryEvent[],
  memberId?: string,
): AgentStatus | undefined {
  // Log significant events
  if (event.type === "agent_start" || event.type === "agent_end") {
    logger.info("runtime", "event", { agent: agentName, type: event.type });
  } else if (event.type === "tool_start") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_start", tool: event.toolName });
    // Cache args for the matching tool_end (tool_end events don't carry args).
    if ((event as any).toolCallId) {
      toolArgsCache.set(`${instanceKey}:${(event as any).toolCallId}`, (event as any).args);
      if (toolArgsCache.size > 200) {
        const firstKey = toolArgsCache.keys().next().value;
        if (firstKey) toolArgsCache.delete(firstKey);
      }
    }
  } else if (event.type === "tool_end") {
    logger.info("runtime", "event", { agent: agentName, type: "tool_end", tool: event.toolName, isError: !!(event as any).isError });
    // Surface knowledge doc writes into the room chat stream (event cards).
    const cacheKey = `${instanceKey}:${(event as any).toolCallId}`;
    const cachedArgs = toolArgsCache.get(cacheKey);
    toolArgsCache.delete(cacheKey);
    try {
      const room = getRoom(roomId);
      maybeEmitKnowledgeActivity(
        roomId, agentName, event.toolName,
        cachedArgs,
        !!(event as any).isError, room?.cwd,
      );
    } catch (err) {
      logger.error("knowledge-activity", "hook failed", { roomId, error: String(err) });
    }
  } else if (event.type === "compaction_start") {
    logger.info("runtime", "event", { agent: agentName, type: "compaction_start", reason: event.reason });
  } else if (event.type === "compaction_end") {
    logger.info("runtime", "event", { agent: agentName, type: "compaction_end", reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, hasError: Boolean(event.errorMessage) });
  }

  // cli:stdout / cli:stderr — forward via WS only, no disk persistence, no status change
  if (event.type === "cli:stdout" || event.type === "cli:stderr") {
    broadcastToAgentSubscribers(roomId, agentName, {
      type: "agent:event",
      roomId,
      agent: agentName,
      memberId,
      event,
    });
    return undefined;
  }

  // runtime_exit — lifecycle signal from the CLI runtime.
  //   unexpected=true  → crash / startup failure: post system message + mark inactive.
  //   unexpected=false → normal shutdown via handle.destroy(): silent.
  if (event.type === "runtime_exit") {
    logger.info("runtime", "exit", {
      agent: agentName, code: event.code, signal: event.signal, unexpected: event.unexpected,
    });
    broadcastToAgentSubscribers(roomId, agentName, {
      type: "agent:event", roomId, agent: agentName, memberId, event,
    });
    if (event.unexpected) {
      return "inactive";
    }
    return undefined;
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

  // message_end: enrich with accumulated content (create new object, don't mutate input)
  let processedEvent: AgentStreamEvent = event;
  if (event.type === "message_end") {
    const state = streamState.get(instanceKey);
    if (state) {
      const enriched: Record<string, unknown> = { ...event };
      if (!event.text && state.text) enriched.text = state.text;
      if (state.thinking) enriched.thinking = state.thinking;
      processedEvent = enriched as AgentStreamEvent;
      streamState.delete(instanceKey);
    }
  }

  // Persist non-streaming events to disk
  if (processedEvent.type !== "message_update" && processedEvent.type !== "tool_update") {
    eventBuffer.push(processedEvent);
    try { appendEventToDisk(roomId, memberId || agentName, processedEvent); } catch (err) { logger.error("event", "disk write failed", { roomId, agent: agentName, memberId, error: String(err) }); }
  }

  // WebSocket push — forward all events for live streaming
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    memberId,
    event: processedEvent,
  });

  // Public status is sourced only from runtime lifecycle events.
  if (processedEvent.type === "agent_start") {
    logger.info("agent", "statusChange", { agent: agentName, status: "working" });
    return "working";
  }

  if (processedEvent.type === "message_end") {
    refreshContextUsage(roomId, memberId || agentName);
  }

  if (processedEvent.type === "compaction_end") {
    refreshContextUsage(roomId, memberId || agentName, { acceptCompactedSnapshot: true, retries: 3, retryDelayMs: 500 });
  }

  if (processedEvent.type === "agent_end") {
    logger.info("agent", "statusChange", { agent: agentName, status: "idle" });
    // Proactively refresh context usage cache at turn end as a fallback.
    refreshContextUsage(roomId, memberId || agentName);
    return "idle";
  }

  return undefined;
}
