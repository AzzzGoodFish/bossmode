/**
 * Tool surface by scope — identity batch-2: memory family retired; leader gate gone
 * (any room member may edit_room / create_topic).
 */
import { parseScopeId, type ScopeId } from "../shared/conversation-ref.js";

export type ScopeToolFamily =
  | "chat"
  | "tasks"
  | "wait"
  | "create_room"
  | "edit_room"
  | "list_members"
  | "query_history";

export interface ScopeToolSurface {
  scopeId: ScopeId;
  kind: "dm" | "room";
  /** Families enabled in this scope. */
  families: ScopeToolFamily[];
  /** Human summary for Active tools panel. */
  summary: string;
}

const DM_FAMILIES: ScopeToolFamily[] = [
  "chat",
  "create_room",
  "edit_room",
  "list_members",
  "query_history",
];

const ROOM_FAMILIES: ScopeToolFamily[] = [
  "chat",
  "tasks",
  "wait",
  "query_history",
  "edit_room",
];

export function toolSurfaceForScope(scopeId: ScopeId, _opts?: { isRoomLeader?: boolean }): ScopeToolSurface {
  const ref = parseScopeId(scopeId);
  if (!ref) throw new Error("scope_not_found");

  if (ref.kind === "dm") {
    return {
      scopeId,
      kind: "dm",
      families: [...DM_FAMILIES],
      summary: "DM: chat, create/edit room, list members, history",
    };
  }

  return {
    scopeId,
    kind: "room",
    families: [...ROOM_FAMILIES],
    summary: "Room: chat, tasks, wait, edit room, history",
  };
}

export function familyEnabled(scopeId: ScopeId, family: ScopeToolFamily, opts?: { isRoomLeader?: boolean }): boolean {
  return toolSurfaceForScope(scopeId, opts).families.includes(family);
}
