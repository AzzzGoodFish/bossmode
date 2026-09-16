/**
 * Tool surface by scope — identity batch-2: memory family retired; leader gate gone
 * (any room member may edit a chat). Batch 3: the `wait` family retired with the
 * wait tool; family labels here feed the Active-tools panel and are refreshed by
 * the member-centric UI batch.
 */
import { parseScopeId, type ScopeId } from "../../chat/conversation-ref.js";

export type ScopeToolFamily =
  | "chat"
  | "chat_create"
  | "chat_edit"
  | "member_list"
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
  "chat_create",
  "chat_edit",
  "member_list",
  "query_history",
];

const ROOM_FAMILIES: ScopeToolFamily[] = [
  "chat",
  "query_history",
  "chat_edit",
];

export function toolSurfaceForScope(scopeId: ScopeId, _opts?: { isRoomLeader?: boolean }): ScopeToolSurface {
  const ref = parseScopeId(scopeId);
  if (!ref) throw new Error("scope_not_found");

  if (ref.kind === "dm") {
    return {
      scopeId,
      kind: "dm",
      families: [...DM_FAMILIES],
      summary: "DM: chat, create/edit chat, members, history",
    };
  }

  return {
    scopeId,
    kind: "room",
    families: [...ROOM_FAMILIES],
    summary: "Room: chat, edit chat, history",
  };
}

export function familyEnabled(scopeId: ScopeId, family: ScopeToolFamily, opts?: { isRoomLeader?: boolean }): boolean {
  return toolSurfaceForScope(scopeId, opts).families.includes(family);
}
