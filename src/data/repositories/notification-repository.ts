import {getDatabase,type Database} from "../database.js";
import type {WsServerEvent} from "../../kernel/types.js";

/** Durable local UI notification, never an instruction to execute agent work. */
export function enqueueScopeNotification(scopeId:string,key:string,event:WsServerEvent,db:Database=getDatabase()):void {
  db.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('scope-notification',?,?,?,?)",
    scopeId,`scope-notification:${scopeId}:${key}`,JSON.stringify(event),Date.now());
}
export function pendingScopeNotifications(limit=500,db:Database=getDatabase()):Array<{id:number;scopeId:string;event:WsServerEvent}> {
  return db.all<{id:number;scope_id:string;payload_json:string}>("SELECT id,scope_id,payload_json FROM outbox WHERE kind='scope-notification' AND delivered_at IS NULL ORDER BY id LIMIT ?",limit)
    .map(row=>({id:row.id,scopeId:row.scope_id,event:JSON.parse(row.payload_json)}));
}
