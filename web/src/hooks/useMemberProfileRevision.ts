import { useSyncExternalStore } from "react";
import type { WsEvent } from "./useWebSocket";

// Layout's existing socket is the single publisher. Only current-identity
// readers subscribe: message/mention snapshots never enter this store.
let revision = 0;
const currentNames = new Map<string, string>();
const memberRevisions = new Map<string, number>();
const listeners = new Set<() => void>();

export function publishMemberProfileChanged(event: Extract<WsEvent, { type: "member:profile" }>): void {
  currentNames.set(event.memberId, event.name);
  memberRevisions.set(event.memberId, ++revision);
  for (const listener of listeners) listener();
}

export function subscribeMemberProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMemberProfileRevision(memberId?: string): number {
  return memberId ? memberRevisions.get(memberId) ?? 0 : revision;
}

/** Stable IDs route live events even if a running turn still carries its old label. */
export function currentMemberName(memberId: string | undefined, fallback: string): string {
  return (memberId && currentNames.get(memberId)) || fallback;
}

export function useMemberProfileRevision(memberId?: string): number {
  return useSyncExternalStore(subscribeMemberProfiles, () => getMemberProfileRevision(memberId), () => 0);
}
