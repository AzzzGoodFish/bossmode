// Cross-scope read authorization (0.20.0 flagship, architect-pinned 2026-08-05).
// One ScopeId convention across the product: `room:<id>` | `dm:<memberId>`.
// Members may READ any scope they belong to (prompt promise); writes stay
// current-scope. This module is the single membership check — tools (①) and
// panel APIs (②) both consume it. Failures throw explicit errors, never
// silently fall back.
import { getMember } from "./member-registry.js";
import { listRooms } from "./room-store.js";
import { getTopic, resolveTopicRoomId } from "./topic-store.js";
import type { Room } from "../shared/types.js";
import type { ScopeId } from "../shared/conversation-ref.js";

/** Rooms a registry member belongs to — stamped rooms by globalMemberIds,
 * legacy unstamped rooms by name membership. */
export function listRoomsForMember(memberId: string): Room[] {
  const member = getMember(memberId);
  if (!member) return [];
  return listRooms().filter((room) => {
    if (Array.isArray(room.globalMemberIds) && room.globalMemberIds.length > 0) {
      return room.globalMemberIds.includes(memberId);
    }
    return (room.members || []).includes(member.name) || (room.roomMembers || []).some((m) => m.name === member.name);
  });
}

export type ScopeAccess =
  | { kind: "room"; roomId: string; room: Room }
  | { kind: "dm"; memberId: string }
  | { kind: "topic"; topicId: string; roomId: string; room: Room };

/**
 * Assert `memberId` may read `scopeId`. Returns the parsed target on success.
 * Throws Error with an explicit reason otherwise (not a member / not own DM /
 * unknown scope). Membership in stamped rooms is by globalMemberIds; legacy
 * unstamped rooms fall back to name membership (same rule as
 * listRoomsForMember). Topic access = membership in the parent room.
 */
export function assertMemberScopeAccess(memberId: string, scopeId: ScopeId): ScopeAccess {
  const member = getMember(memberId);
  if (!member) throw new Error(`Unknown member: ${memberId}`);
  if (scopeId.startsWith("dm:")) {
    const target = scopeId.slice("dm:".length);
    if (target !== memberId) throw new Error("Access denied: a member can only read its own DM scope");
    return { kind: "dm", memberId: target };
  }
  if (scopeId.startsWith("topic:")) {
    const topicId = scopeId.slice("topic:".length);
    const roomId = resolveTopicRoomId(topicId);
    if (!roomId) throw new Error(`Unknown topic scope: ${scopeId}`);
    const room = listRoomsForMember(memberId).find((r) => r.id === roomId);
    if (!room) throw new Error(`Access denied: ${member.name} is not a member of topic parent room ${roomId}`);
    if (!getTopic(roomId, topicId)) throw new Error(`Topic not found: ${topicId}`);
    return { kind: "topic", topicId, roomId, room };
  }
  if (scopeId.startsWith("room:")) {
    const roomId = scopeId.slice("room:".length);
    const room = listRoomsForMember(memberId).find((r) => r.id === roomId);
    if (!room) throw new Error(`Access denied: ${member.name} is not a member of room ${roomId} (or the room does not exist)`);
    return { kind: "room", roomId, room };
  }
  throw new Error(`scope must be 'room:<id>', 'dm:<memberId>', or 'topic:<topicId>', got: ${scopeId}`);
}
