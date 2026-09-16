import { getDatabase } from "./database.js";

export interface UsageRow {
  room_id: string; member_id: string; date: string; model: string;
  input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; cost: number; turns: number;
}
export interface UsageQuery { scopeId?: string; memberId?: string; from?: string; to?: string; model?: string }

/** Coherent usage and identity snapshot. Missing/unreadable storage is an error, never empty success. */
export function readUsageReport(query: UsageQuery) {
  return getDatabase().transaction(db => {
    const filters: string[] = []; const values: string[] = [];
    for (const [column, op, value] of [
      ["room_id", "=", query.scopeId], ["member_id", "=", query.memberId],
      ["date", ">=", query.from], ["date", "<=", query.to], ["model", "=", query.model],
    ]) if (value !== undefined) { filters.push(`${column} ${op} ?`); values.push(value); }
    const rows = db.all<UsageRow>(`SELECT room_id,member_id,date,model,input_tokens,output_tokens,cache_read,cache_write,cost,turns FROM token_usage_daily${filters.length ? " WHERE " + filters.join(" AND ") : ""}`, ...values);
    // Stable IDs retain historical attribution even after roster removal or archiving.
    const members = db.all<{id:string;name:string;agent_template:string}>("SELECT id,name,agent_template FROM members");
    const rooms = db.all<{id:string;name:string}>("SELECT id,name FROM rooms");
    return {
      rows,
      memberMeta: new Map(members.map(m => [m.id, { name: m.name, agent: m.agent_template }])),
      roomNames: new Map(rooms.map(r => [r.id,r.name])),
    };
  });
}
