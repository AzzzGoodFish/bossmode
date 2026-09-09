// Agent event handling — stream accumulation, authoritative persistence, commit-safe WS push
import { randomUUID } from "node:crypto";
import { pendingAgentEventDispatches, recordDispatchAttempt, markDispatchDelivered } from "../storage/message-dispatch-repository.js";
import { appendAgentEvent, readAgentEvents, pageAgentEvents, type EventOwner } from "../storage/event-repository.js";
import { logger } from "../foundation/logger.js";
import { broadcastToAgentSubscribers } from "../communication/ws.js";
import { refreshContextUsage } from "./agent-manager.js";
import { maybeEmitKnowledgeActivity } from "./knowledge-activity.js";
import { getRoom } from "../workspace/room-store.js";
import type { AgentStreamEvent } from "./runtime/types.js";
import type { AgentStatus } from "../shared/types.js";
import { limitRuntimeErrorEvent } from "../shared/runtime-error-limit.js";

export type AgentHistoryEvent =
  | AgentStreamEvent
  | { type: "user_prompt"; text: string; trigger: string; ts?: number }
  | { type: "user_steer"; text: string; ts?: number }
  | { type: "agent_reply"; text: string; ts?: number }
  | { type: "system"; text: string; ts?: number };

// -- Event persistence (DB). Existing public names remain for caller integration. --
const eventIdentities = new WeakMap<object,string>();
function identityFor(event: object): string {
  let id = eventIdentities.get(event);
  if (!id) { id = randomUUID(); eventIdentities.set(event,id); }
  return id;
}
export function appendEventToDisk(roomId: string,agentRef: string,event: AgentHistoryEvent,eventId = identityFor(event)): void {
  // Existing callers supply a stable member ID; historical name-only data must
  // use the strict importer with memberId:null, never this live entry point.
  persistAgentEvent(roomId,{ownerKey:agentRef,memberId:agentRef},event,eventId);
}
export function persistAgentEvent(scopeId: string,owner: EventOwner,event: AgentHistoryEvent,eventId = identityFor(event)): AgentHistoryEvent {
  const fact = appendAgentEvent(scopeId,owner,limitRuntimeErrorEvent(event),eventId);
  scheduleAgentEventDispatch();
  return fact.event as AgentHistoryEvent;
}
/** Sequences now come from DB facts, no process counter to clear. */
export function resetEventSeqCache(): void {}
export function loadEventsFromDisk(roomId: string,agentRef: string): AgentHistoryEvent[] { return readAgentEvents<AgentHistoryEvent>(roomId,agentRef); }
export function loadEventsPaginated(roomId: string,agentRef: string,limit: number,before?: number): {events:AgentHistoryEvent[];total:number;hasMore:boolean} { return pageAgentEvents<AgentHistoryEvent>(roomId,agentRef,limit,before); }

let eventDispatchScheduled = false;
/** Parent schedules at startup after socket subscriptions/runtime recovery, and on retry timer. */
export function scheduleAgentEventDispatch(): void {
  if (eventDispatchScheduled) return;
  eventDispatchScheduled = true;
  queueMicrotask(() => {
    eventDispatchScheduled = false;
    try {
      const rows = pendingAgentEventDispatches();
      for (const {id,fact,agentName,memberId} of rows) {
        recordDispatchAttempt(id);
        broadcastToAgentSubscribers(fact.scopeId,agentName,{type:"agent:event",roomId:fact.scopeId,agent:agentName,memberId:memberId ?? undefined,event:fact.event});
        markDispatchDelivered(id);
      }
      if (rows.length === 500) scheduleAgentEventDispatch();
    } catch (error) { logger.error("event","durable event dispatch pending",{error:String(error)}); }
  });
}

// -- Stream state accumulation --

// Accumulate streaming text/thinking so message_end has complete content
const toolArgsCache = new Map<string, unknown>();

const streamState = new Map<string, { text: string; thinking: string }>();

/**
 * Handle an agent stream event:
 * 1. Accumulate text/thinking from message_update
 * 2. Enrich message_end with accumulated content
 * 3. Persist non-streaming events to DB
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
  model?: string,
  eventId = identityFor(event),
): AgentStatus | undefined {
  event = limitRuntimeErrorEvent(event);

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
    const enriched: Record<string, unknown> = { ...event };
    if (state) {
      if (!event.text && state.text) enriched.text = state.text;
      if (state.thinking) enriched.thinking = state.thinking;
      streamState.delete(instanceKey);
    }
    // Stamp the live model so by-model usage stats are possible going forward.
    // Pre-stamp history stays in the 'unknown' bucket (backfill). Only stamp
    // when we actually know it ("provider/modelId"); omit otherwise.
    if (model && model.trim() && !("model" in enriched)) enriched.model = model;
    processedEvent = enriched as AgentStreamEvent;
  }

  // One stamp for DB + WS so live feed sort and REST reload share identity.
  // Keep an existing ts (tool/user_prompt may already carry one).
  const stamped: AgentStreamEvent & { ts?: number } =
    typeof (processedEvent as { ts?: number }).ts === "number" && Number.isFinite((processedEvent as { ts?: number }).ts)
      ? (processedEvent as AgentStreamEvent & { ts?: number })
      : { ...processedEvent, ts: Date.now() };

  // Persist facts, usage, stats and notification intent together. A failed commit
  // propagates; no successful buffer entry or final-event broadcast is fabricated.
  if (stamped.type !== "message_update" && stamped.type !== "tool_update") {
    const persisted = persistAgentEvent(roomId,{ownerKey:memberId ?? `unresolved:${agentName}`,memberId:memberId ?? null,label:agentName},stamped,eventId);
    eventBuffer.push(persisted);
  } else {
    // Intentional transient deltas remain realtime-only.
    broadcastToAgentSubscribers(roomId,agentName,{type:"agent:event",roomId,agent:agentName,memberId,event:stamped});
  }

  // Public status is sourced only from runtime lifecycle events.
  if (stamped.type === "agent_start") {
    logger.info("agent", "statusChange", { agent: agentName, status: "working" });
    return "working";
  }

  if (stamped.type === "message_end") {
    refreshContextUsage(roomId, memberId || agentName);
  }

  if (stamped.type === "compaction_end") {
    refreshContextUsage(roomId, memberId || agentName, { acceptCompactedSnapshot: true, retries: 3, retryDelayMs: 500 });
  }

  if (stamped.type === "agent_end") {
    // pi session-level retry: agent_end.willRetry means another attempt is imminent.
    // Do not flip public status to idle or refresh context mid-retry (fish 2026-08-09).
    if (stamped.willRetry) {
      logger.info("agent", "statusChange", { agent: agentName, status: "working", reason: "agent_end_willRetry" });
      return undefined;
    }
    logger.info("agent", "statusChange", { agent: agentName, status: "idle" });
    // Proactively refresh context usage cache at turn end as a fallback.
    refreshContextUsage(roomId, memberId || agentName);
    return "idle";
  }

  return undefined;
}
