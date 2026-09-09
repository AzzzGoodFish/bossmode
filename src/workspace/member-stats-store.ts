import { readStats, hasStats, rebuildEventAggregates } from "../storage/event-repository.js";
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

export const readMemberStats = readStats;
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

export const statsFileExists = hasStats;
/** Retained migration call surface; file-derived input is never made authoritative.
 * Parent removes old startup backfills and runs rebuildEventAggregates after strict import.
 */
export function writeBackfilledStats(_scopeId: string,_ownerKey: string,_stats: MemberStats): void { rebuildEventAggregates(); }
