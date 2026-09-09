// Activity is an indexed query of authoritative event payloads, not a file projection.
import { getDatabase, type Database } from "../../storage/database.js";
import { ACTIVITY_TYPES, pageActivity } from "../../storage/event-repository.js";
export const INDEXED_ACTIVITY_TYPES = ACTIVITY_TYPES;
export interface ActivityPage { events: unknown[]; hasMore: boolean; nextBeforeSeq: number | null; indexed: boolean }
export const queryActivityPage = pageActivity;
/** No catch-up is required: event facts and query indexes commit together. */
export function catchUpActivityIndex(_roomId: string,_memberId: string): void { getDatabase().get("SELECT 1 FROM agent_events LIMIT 1"); }
export function countActivityRows(db: Pick<Database,"get">,roomId: string,memberId: string): number {
  return db.get<{n:number}>(`SELECT COUNT(*) n FROM agent_events WHERE scope_id=? AND owner_key=? AND type IN (${[...ACTIVITY_TYPES].map(() => "?").join(",")})`,roomId,memberId,...ACTIVITY_TYPES)?.n ?? 0;
}
