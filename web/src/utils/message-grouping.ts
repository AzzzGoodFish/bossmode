/**
 * Chat message grouping (extracted from ChatArea for testability).
 *
 * Grouping = consecutive bubbles from the same sender within a short interval
 * collapse into one visual group (avatar/sender row only on the first).
 *
 * Typed event cards (task/knowledge/topic) are boundary BREAKERS: they render
 * as cards, not bubbles — messages never merge across them, and a card never
 * joins a bubble group. (fish 2026-08-19: a user message right after a
 * "you opened topic" card — sender "user" — lost its avatar/sender row because
 * the card counted as the same-group predecessor.)
 */
import { isSameLocalDate } from "./message-date";
import type { RoomMessage } from "../api/client";

export const GROUP_INTERVAL_MS = 5 * 60 * 1000;

export function isGroupedWithPrev(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return false;
  if (prev.type || current.type) return false;
  if (prev.sender !== current.sender) return false;
  if (current.ts - prev.ts > GROUP_INTERVAL_MS) return false;
  if (!isSameLocalDate(prev.ts, current.ts)) return false;
  return true;
}
