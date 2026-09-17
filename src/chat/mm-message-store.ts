/**
 * Member↔member private chat store (⑤ B, fish #20135).
 *
 * Scope id is the canonical `mm:<a>-<b>` pair; message rows live in the shared
 * `messages` table keyed by that scope (no per-scope files). Both members keep
 * their own message-ID cursor in the shared `read_cursors` table.
 */
import { limitRuntimeFailureRoomMessage } from "../kernel/runtime-error-limit.js";
import type { RoomMessage } from "../kernel/types.js";
import { appendMessage, readMessages, latestMessage, readMemberCursor, writeMemberCursor } from "../data/repositories/message-repository.js";
import { mmScopeIdOf, parseMmScopeId } from "./conversations.js";

export { mmScopeIdOf } from "./conversations.js";

export function readAllMmMessages(scopeId: string): RoomMessage[] {
  return readMessages(scopeId).map(limitRuntimeFailureRoomMessage);
}

export function addMmMessage(scopeId: string, msg: Omit<RoomMessage, "id" | "ts" | "seq">): RoomMessage {
  return appendMessage(scopeId, msg);
}

export function getLatestMmMessage(scopeId: string): RoomMessage | null {
  return latestMessage(scopeId);
}

/** The other member of the pair from `memberId`'s point of view, or null. */
export function mmCounterpart(scopeId: string, memberId: string): string | null {
  const pair = parseMmScopeId(scopeId);
  if (!pair || !pair.includes(memberId)) return null;
  return pair.find((id) => id !== memberId) ?? null;
}

export function getMmCursor(scopeId: string, memberId: string): string | null {
  return readMemberCursor(scopeId, memberId);
}

export function setMmCursor(scopeId: string, memberId: string, value: string | null): void {
  writeMemberCursor(scopeId, memberId, value);
}
