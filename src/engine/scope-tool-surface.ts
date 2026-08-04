/**
 * 0.20 tool surface by scope — which platform tools a member gets in DM vs room.
 * Contract + product spec: DM has create/edit room + member directory; room has tasks/wait;
 * memory/query tools are shared with optional scope param (default = current).
 */
import { parseScopeId, type ScopeId } from "../shared/conversation-ref.js";

export type ScopeToolFamily =
  | "chat"
  | "memory"
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
  "memory",
  "create_room",
  "edit_room",
  "list_members",
  "query_history",
];

const ROOM_FAMILIES: ScopeToolFamily[] = [
  "chat",
  "memory",
  "tasks",
  "wait",
  "query_history",
  // edit_room only when leader — gated at tool execution, still listed for leaders via flag
  "edit_room",
];

export function toolSurfaceForScope(scopeId: ScopeId, opts?: { isRoomLeader?: boolean }): ScopeToolSurface {
  const ref = parseScopeId(scopeId);
  if (!ref) throw new Error("scope_not_found");

  if (ref.kind === "dm") {
    return {
      scopeId,
      kind: "dm",
      families: [...DM_FAMILIES],
      summary: "DM: chat, memory, create/edit room, list members, history",
    };
  }

  const families = ROOM_FAMILIES.filter((f) => f !== "edit_room" || opts?.isRoomLeader);
  return {
    scopeId,
    kind: "room",
    families,
    summary: opts?.isRoomLeader
      ? "Room: chat, memory, tasks, wait, edit room (leader), history"
      : "Room: chat, memory, tasks, wait, history",
  };
}

export function familyEnabled(scopeId: ScopeId, family: ScopeToolFamily, opts?: { isRoomLeader?: boolean }): boolean {
  return toolSurfaceForScope(scopeId, opts).families.includes(family);
}
