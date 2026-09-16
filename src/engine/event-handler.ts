// Agent event handling — stream accumulation, authoritative persistence, commit-safe WS push
import { randomUUID } from "node:crypto";
import { pendingAgentEventDispatches, recordDispatchAttempt, markDispatchDelivered } from "../data/repositories/message-dispatch-repository.js";
import { appendSourceAgentEvent, hasAgentEvent, readAgentEvents, pageAgentEvents, type EventOwner } from "../data/repositories/event-repository.js";
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { broadcastToAgentSubscribers } from "../communication/ws.js";
import { refreshContextUsage } from "./agent-manager.js";
import { maybeEmitKnowledgeActivity } from "./knowledge-activity.js";
import { getRoom } from "../workspace/room-store.js";
import type { AgentStreamEvent } from "./runtime/types.js";
import type { AgentStatus } from "../kernel/types.js";
import { limitRuntimeErrorEvent } from "../kernel/runtime-error-limit.js";

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
  const { fact } = appendSourceAgentEvent(scopeId,owner,event,eventId,() => limitRuntimeErrorEvent(event));
  getDatabase().afterCommit(scheduleAgentEventDispatch);
  return fact.event as AgentHistoryEvent;
}
/** Sequences now come from DB facts, no process counter to clear. */
export function resetEventSeqCache(): void {}
export function loadEventsFromDisk(roomId: string,agentRef: string): AgentHistoryEvent[] { return readAgentEvents<AgentHistoryEvent>(roomId,agentRef).map(limitRuntimeErrorEvent); }
export function loadEventsPaginated(roomId: string,agentRef: string,limit: number,before?: number): {events:AgentHistoryEvent[];total:number;hasMore:boolean} { const page=pageAgentEvents<AgentHistoryEvent>(roomId,agentRef,limit,before); return {...page,events:page.events.map(limitRuntimeErrorEvent)}; }

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

interface StreamBoundary { eventId: string; textEnd: number; thinkingEnd: number }
interface StreamState {
  text: string; thinking: string; textOffset: number; thinkingOffset: number;
  generation: { pending: StreamBoundary[] };
}
const streamState = new Map<string, StreamState>();
function boundaryOf(eventId: string, state: StreamState): StreamBoundary {
  return { eventId, textEnd: state.textOffset + state.text.length, thinkingEnd: state.thinkingOffset + state.thinking.length };
}
function streamContent(state: StreamState): { text: string; thinking: string } {
  // A prior final/start in the same transaction delimits the next message, but
  // does not delete its text. Rolled-back boundaries have no fact and are ignored.
  const pending = state.generation.pending.filter(boundary => hasAgentEvent(boundary.eventId));
  state.generation.pending = pending;
  const textStart = Math.max(state.textOffset, ...pending.map(boundary => boundary.textEnd));
  const thinkingStart = Math.max(state.thinkingOffset, ...pending.map(boundary => boundary.thinkingEnd));
  return { text: state.text.slice(textStart - state.textOffset), thinking: state.thinking.slice(thinkingStart - state.thinkingOffset) };
}
function consumeStream(instanceKey: string, eventId: string, captured: StreamState | undefined): void {
  if (!captured) return;
  captured.generation.pending = captured.generation.pending.filter(boundary => boundary.eventId !== eventId);
  const current = streamState.get(instanceKey);
  if (current?.generation !== captured.generation) return;
  const boundary = boundaryOf(eventId, captured);
  const textOffset = Math.max(current.textOffset, boundary.textEnd);
  const thinkingOffset = Math.max(current.thinkingOffset, boundary.thinkingEnd);
  if (textOffset === current.textOffset + current.text.length && thinkingOffset === current.thinkingOffset + current.thinking.length) streamState.delete(instanceKey);
  else streamState.set(instanceKey, {
    ...current, textOffset, thinkingOffset,
    text: current.text.slice(textOffset - current.textOffset),
    thinking: current.thinking.slice(thinkingOffset - current.thinkingOffset),
  });
}

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
  const source = event;
  event = limitRuntimeErrorEvent(event);

  const observeEvent = () => {
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
  };

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
    const state = { ...(streamState.get(instanceKey) || { text: "", thinking: "", textOffset: 0, thinkingOffset: 0, generation: { pending: [] } }) };
    if ("text" in event && event.text) state.text += event.text;
    if ("thinking" in event && event.thinking) state.thinking += event.thinking;
    streamState.set(instanceKey, state);
  }

  // Capture this generation without consuming it. A failed savepoint or outer
  // transaction must leave the complete final available to the retry.
  const state = event.type === "message_end" || event.type === "message_start" ? streamState.get(instanceKey) : undefined;
  let stamped: AgentStreamEvent & { ts?: number };
  if (event.type !== "message_update" && event.type !== "tool_update") {
    const { fact, inserted } = appendSourceAgentEvent(
      roomId, {ownerKey:memberId ?? `unresolved:${agentName}`,memberId:memberId ?? null,label:agentName},
      source, eventId, () => {
        const enriched: Record<string, unknown> = { ...event };
        if (event.type === "message_end") {
          if (state) {
            const content = streamContent(state);
            if (!event.text && content.text) enriched.text = content.text;
            if (content.thinking) enriched.thinking = content.thinking;
          }
          if (model && model.trim() && !("model" in enriched)) enriched.model = model;
        }
        return enriched as AgentStreamEvent;
      },
    );
    stamped = fact.event as AgentStreamEvent;
    const committedEvent = stamped;
    getDatabase().afterCommit(scheduleAgentEventDispatch);
    if (inserted) {
      if (state) state.generation.pending.push(boundaryOf(eventId, state));
      getDatabase().afterCommit(() => {
        // Do not erase a newer generation started while the outer commit waited.
        consumeStream(instanceKey, eventId, state);
        eventBuffer.push(committedEvent);
      });
      getDatabase().afterCommit(observeEvent);
      getDatabase().afterCommit(() => {
        if (committedEvent.type === "message_end" || (committedEvent.type === "agent_end" && !committedEvent.willRetry)) {
          refreshContextUsage(roomId, memberId || agentName);
        } else if (committedEvent.type === "compaction_end") {
          refreshContextUsage(roomId, memberId || agentName, { acceptCompactedSnapshot: true, retries: 3, retryDelayMs: 500 });
        }
      });
    }
  } else {
    const transient = event as AgentStreamEvent & { ts?: number };
    stamped = typeof transient.ts === "number" && Number.isFinite(transient.ts) ? transient : { ...transient, ts: Date.now() };
    // Intentional transient deltas remain realtime-only.
    broadcastToAgentSubscribers(roomId,agentName,{type:"agent:event",roomId,agent:agentName,memberId,event:stamped});
  }

  // Public status is sourced only from runtime lifecycle events.
  if (stamped.type === "agent_start") {
    logger.info("agent", "statusChange", { agent: agentName, status: "working" });
    return "working";
  }

  if (stamped.type === "agent_end") {
    // pi session-level retry: agent_end.willRetry means another attempt is imminent.
    // Do not flip public status to idle or refresh context mid-retry (fish 2026-08-09).
    if (stamped.willRetry) {
      logger.info("agent", "statusChange", { agent: agentName, status: "working", reason: "agent_end_willRetry" });
      return undefined;
    }
    logger.info("agent", "statusChange", { agent: agentName, status: "idle" });
    return "idle";
  }

  return undefined;
}
