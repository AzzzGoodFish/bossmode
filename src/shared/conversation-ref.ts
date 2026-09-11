/**
 * 0.20 ConversationRef — unique scope key for sessions, activation, cursors, wait, memory.
 * Contract: docs/bossmode/architecture/contract-020-conversation-ref-and-rest-v1.md §1/§5/§6
 * Topic scopes were retired 2026-09-11 (plan-retire-topics-v2).
 */

export type ConversationRef =
  | { kind: "dm"; memberId: string }
  | { kind: "room"; roomId: string };

/** Serialized form used in storage keys, logs, URL `scope=` params. */
export type ScopeId = string; // "dm:<memberId>" | "room:<roomId>"

const DM_PREFIX = "dm:";
const ROOM_PREFIX = "room:";

export function scopeIdOf(ref: ConversationRef): ScopeId {
  if (ref.kind === "dm") {
    if (!ref.memberId) throw new Error("dm ConversationRef requires memberId");
    return `${DM_PREFIX}${ref.memberId}`;
  }
  if (!ref.roomId) throw new Error("room ConversationRef requires roomId");
  return `${ROOM_PREFIX}${ref.roomId}`;
}

/** Parse a ScopeId. Returns null on illegal input (never throws). */
export function parseScopeId(s: string): ConversationRef | null {
  if (typeof s !== "string" || !s) return null;
  if (s.startsWith(DM_PREFIX)) {
    const memberId = s.slice(DM_PREFIX.length);
    if (!memberId || memberId.includes(":")) return null;
    return { kind: "dm", memberId };
  }
  if (s.startsWith(ROOM_PREFIX)) {
    const roomId = s.slice(ROOM_PREFIX.length);
    if (!roomId || roomId.includes(":")) return null;
    return { kind: "room", roomId };
  }
  return null;
}

/**
 * Room id owning chat-scope assets (roster, attachments): `room:<id>` or a bare
 * room id → room id; DM scopes → null (no room-owned assets).
 */
export function chatScopeRoomId(scopeOrRoomId: string): string | null {
  if (scopeOrRoomId.startsWith(DM_PREFIX)) return null;
  return scopeOrRoomId.startsWith(ROOM_PREFIX) ? scopeOrRoomId.slice(ROOM_PREFIX.length) : scopeOrRoomId;
}

/**
 * Filesystem-safe directory segment for a scope under a member tree.
 * - dm:<memberId> → "dm"
 * - room:<roomId> → "room-<roomId>"
 */
export function scopeDirName(refOrScope: ConversationRef | ScopeId): string {
  const ref = typeof refOrScope === "string" ? parseScopeId(refOrScope) : refOrScope;
  if (!ref) throw new Error(`invalid scope for directory name: ${String(refOrScope)}`);
  if (ref.kind === "dm") return "dm";
  return `room-${ref.roomId}`;
}

/** Inverse of scopeDirName when the memberId context is known (for dm). */
export function parseScopeDirName(dirName: string, memberIdForDm: string): ConversationRef | null {
  if (dirName === "dm") {
    if (!memberIdForDm) return null;
    return { kind: "dm", memberId: memberIdForDm };
  }
  if (dirName.startsWith("room-")) {
    const roomId = dirName.slice("room-".length);
    if (!roomId) return null;
    return { kind: "room", roomId };
  }
  return null;
}

/** Runtime instance table key: scope first so sessions group by conversation. */
export function instanceKey(scopeId: ScopeId, memberId: string): string {
  if (!scopeId || !memberId) throw new Error("instanceKey requires scopeId and memberId");
  return `${scopeId}:${memberId}`;
}

export function parseInstanceKey(key: string): { scopeId: ScopeId; memberId: string } | null {
  if (typeof key !== "string") return null;
  // scopeId itself contains one colon (dm:x | room:x); split after the prefix.
  const m = key.match(/^(dm:[^:]+|room:[^:]+):(.+)$/);
  if (!m) return null;
  if (!parseScopeId(m[1])) return null;
  if (!m[2]) return null;
  return { scopeId: m[1], memberId: m[2] };
}

/** Member id allocator prefix (contract: mem_<uuid>). */
export function isMemberId(id: string): boolean {
  return typeof id === "string" && /^mem_[A-Za-z0-9-]+$/.test(id);
}

/** Room id for asset inheritance (room → self; dm → null). */
export function parentRoomIdOf(refOrScope: ConversationRef | ScopeId): string | null {
  const ref = typeof refOrScope === "string" ? parseScopeId(refOrScope) : refOrScope;
  if (!ref) return null;
  return ref.kind === "room" ? ref.roomId : null;
}
