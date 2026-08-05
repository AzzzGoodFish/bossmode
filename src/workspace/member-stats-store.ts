// Member stats store — persistent, incrementally updated per-member counters:
// turns, tool calls, active time (sum of agent_start..agent_end spans), and
// cumulative token usage/cost. Updated in the event pipeline (event-handler.ts)
// as events are persisted, so reading is O(1) instead of re-scanning the
// member's entire agent-events JSONL on every request.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";

export interface MemberStats {
  turns: number;
  toolCalls: number;
  /** Cumulative active work time in ms: sum of (agent_end.ts - agent_start.ts) per turn. */
  activeMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  updatedAt?: number;
}

function emptyStats(): MemberStats {
  return { turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
}

function statsPath(roomId: string, memberRef: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "agent-events", `${memberRef}.stats.json`);
}

export function readMemberStats(roomId: string, memberRef: string): MemberStats {
  const path = statsPath(roomId, memberRef);
  if (!existsSync(path)) return emptyStats();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return { ...emptyStats(), ...raw, tokens: { ...emptyStats().tokens, ...(raw.tokens || {}) } };
  } catch (err) {
    logger.error("member-stats-store", "failed to read stats", { roomId, memberRef, error: String(err) });
    return emptyStats();
  }
}

function writeMemberStats(roomId: string, memberRef: string, stats: MemberStats): void {
  const path = statsPath(roomId, memberRef);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...stats, updatedAt: Date.now() }, null, 2), "utf-8");
}

// In-memory turn-start timestamps, keyed by instanceKey (roomId:memberRef pair
// the caller already tracks) — mirrors the streamState pattern in event-handler.ts.
// A turn only contributes to activeMs once it has a matched start and end.
const turnStartTs = new Map<string, number>();

export function recordTurnStart(instanceKey: string, ts: number): void {
  turnStartTs.set(instanceKey, ts);
}

export function recordTurnEnd(roomId: string, memberRef: string, instanceKey: string, ts: number): void {
  const startTs = turnStartTs.get(instanceKey);
  turnStartTs.delete(instanceKey);
  const stats = readMemberStats(roomId, memberRef);
  stats.turns += 1;
  if (startTs !== undefined && ts > startTs) stats.activeMs += ts - startTs;
  writeMemberStats(roomId, memberRef, stats);
}

export function recordToolCall(roomId: string, memberRef: string): void {
  const stats = readMemberStats(roomId, memberRef);
  stats.toolCalls += 1;
  writeMemberStats(roomId, memberRef, stats);
}

export function recordTokenUsage(roomId: string, memberRef: string, usage: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number }): void {
  const stats = readMemberStats(roomId, memberRef);
  stats.tokens.input += usage.inputTokens || 0;
  stats.tokens.output += usage.outputTokens || 0;
  stats.tokens.cacheRead += usage.cacheRead || 0;
  stats.tokens.cacheWrite += usage.cacheWrite || 0;
  stats.cost += usage.cost || 0;
  writeMemberStats(roomId, memberRef, stats);
}

/** Recompute stats from scratch given a full raw event list. Used by the
 * backfill migration and directly testable without touching disk. */
export function computeStatsFromEvents(events: Array<{ type: string; ts?: number; usage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number } }>): MemberStats {
  const stats = emptyStats();
  let openStartTs: number | undefined;
  for (const event of events) {
    if (event.type === "agent_start") {
      openStartTs = typeof event.ts === "number" ? event.ts : undefined;
    } else if (event.type === "agent_end") {
      stats.turns += 1;
      if (openStartTs !== undefined && typeof event.ts === "number" && event.ts > openStartTs) {
        stats.activeMs += event.ts - openStartTs;
      }
      openStartTs = undefined;
    } else if (event.type === "tool_start") {
      stats.toolCalls += 1;
    } else if (event.type === "message_end" && event.usage) {
      stats.tokens.input += event.usage.inputTokens || 0;
      stats.tokens.output += event.usage.outputTokens || 0;
      stats.tokens.cacheRead += event.usage.cacheRead || 0;
      stats.tokens.cacheWrite += event.usage.cacheWrite || 0;
      stats.cost += event.usage.cost || 0;
    }
  }
  return stats;
}

export function statsFileExists(roomId: string, memberRef: string): boolean {
  return existsSync(statsPath(roomId, memberRef));
}

export function writeBackfilledStats(roomId: string, memberRef: string, stats: MemberStats): void {
  writeMemberStats(roomId, memberRef, stats);
}
