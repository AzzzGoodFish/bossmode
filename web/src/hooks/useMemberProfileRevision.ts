import { useSyncExternalStore } from "react";
import type { WsEvent } from "./useWebSocket";

// The identity directory and Layout's socket publish current labels by ID.
// Historical message/mention objects never enter this store.
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

/** Apply a complete read snapshot without overwriting a newer profile event. */
export function seedCurrentMemberNames(members: ReadonlyArray<{id: string; name: string}>, startedAtRevision: number): void {
  const ids = new Set(members.map(member => member.id));
  let changed = false;
  for (const [id] of currentNames) {
    if (!ids.has(id) && getMemberProfileRevision(id) <= startedAtRevision) {
      currentNames.delete(id); changed = true;
    }
  }
  for (const member of members) {
    if (getMemberProfileRevision(member.id) > startedAtRevision) continue;
    if (currentNames.get(member.id) !== member.name) {
      currentNames.set(member.id, member.name); changed = true;
    }
  }
  // Directory reads are not profile mutations: existing revision-based effects
  // must not refetch themselves in a loop. Name subscribers compare strings.
  if (changed) for (const listener of listeners) listener();
}

export function clearCurrentMemberNames(): void {
  currentNames.clear();
  for (const listener of listeners) listener();
}

/** Unknown authors retain their recorded labels; names never resolve identity. */
export function useCurrentMemberName(memberId: string | undefined, recordedName: string): string {
  return useSyncExternalStore(subscribeMemberProfiles,
    () => currentMemberName(memberId, recordedName), () => recordedName);
}
