import { getDatabase } from "../database.js";
import type { RoomMessage } from "../../kernel/types.js";
import { readAgentEvent } from "./event-repository.js";

/** C's local outbox queries. Only dispatchers on a fresh post-transaction stack call these. */
export function pendingMessageDispatches(limit = 500): Array<{id:number;scopeId:string;message:RoomMessage}> {
  return getDatabase().all<{id:number;scope_id:string;payload_json:string}>("SELECT id,scope_id,payload_json FROM outbox WHERE kind='message' AND delivered_at IS NULL ORDER BY id LIMIT ?",limit).map(row => {
    // A committed snapshot survives subsequent card patches/history archiving.
    // Queries still use message facts, never outbox payloads.
    const message = (JSON.parse(row.payload_json) as {message:RoomMessage}).message;
    if (!message) throw new Error(`Missing durable message snapshot: ${row.id}`);
    return {id:row.id,scopeId:row.scope_id,message};
  });
}
export function pendingAgentEventDispatches(limit = 500) {
  const db = getDatabase();
  return db.all<{id:number;payload_json:string}>("SELECT id,payload_json FROM outbox WHERE kind='agent-event' AND delivered_at IS NULL ORDER BY id LIMIT ?",limit).map(row => {
    const payload = JSON.parse(row.payload_json) as {eventId:string;agentName:string;memberId:string | null};
    const fact = readAgentEvent(payload.eventId,db);
    if (!fact) throw new Error(`Missing committed agent event: ${payload.eventId}`);
    return {id:row.id,fact,agentName:payload.agentName,memberId:payload.memberId};
  });
}
export function recordDispatchAttempt(id: number): void { getDatabase().run("UPDATE outbox SET attempts=attempts+1 WHERE id=?",id); }
export function markDispatchDelivered(id: number): void { getDatabase().run("UPDATE outbox SET delivered_at=? WHERE id=?",Date.now(),id); }
export function isDispatchDelivered(id: number): boolean { return getDatabase().get<{delivered_at:number | null}>("SELECT delivered_at FROM outbox WHERE id=?",id)?.delivered_at != null; }
