import { readStats, hasStats, rebuildEventAggregates } from "../../agent/events.js";
import type { MemberStats } from "../../data/types.js";

export type { MemberStats };

function emptyStats(): MemberStats {
  return { turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
}

export function readMemberStats(scopeOrMemberId: string, memberId?: string): MemberStats {
  return readStats(memberId ?? scopeOrMemberId);
}
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

export function statsFileExists(scopeOrMemberId: string, memberId?: string): boolean {
  return hasStats(memberId ?? scopeOrMemberId);
}
/** Retained migration call surface; file-derived input is never made authoritative.
 * Parent removes old startup backfills and runs rebuildEventAggregates after strict import.
 */
export function writeBackfilledStats(_scopeId: string,_ownerKey: string,_stats: MemberStats): void { rebuildEventAggregates(); }
