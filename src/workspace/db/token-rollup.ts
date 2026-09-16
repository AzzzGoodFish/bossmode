import { getDatabase, type Database } from "../../data/database.js";
import { applyEventUsage, rebuildEventAggregates } from "../../data/repositories/event-repository.js";
export interface UsageDelta { inputTokens?: number; outputTokens?: number; cacheRead?: number; cacheWrite?: number; cost?: number }
/** A unique stored event is required. Arbitrary additive deltas are not an authority. */
export function recordDailyUsage(eventId: string,db: Database = getDatabase()): void { applyEventUsage(db,eventId); }
export const rebuildDailyUsage = rebuildEventAggregates;
