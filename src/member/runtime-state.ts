// DB-owned runtime recovery metadata. Module import never initializes storage.
// ① B8 / C3: runtime checkpoints are member-level — one entry per member,
// independent of the chat being served.
import { getDatabase } from "../data/database.js";
import { RuntimeRepository } from "../data/repositories/runtime-repository.js";
import type { MountStale, RuntimeStateEntry, RuntimeStateMap } from "../data/types.js";

export type { MountStale, RuntimeStateEntry, RuntimeStateMap };

function repository(): RuntimeRepository { return new RuntimeRepository(getDatabase()); }

export function readRuntimeState(): RuntimeStateMap { return repository().list(); }
export function getRuntimeStateEntry(memberId: string): RuntimeStateEntry { return repository().get(memberId); }
export function updateRuntimeStateEntry(memberId: string, patch: RuntimeStateEntry): void {
  repository().update(memberId, current => ({...current, ...patch}), Date.now());
}
export function setContractFingerprint(memberId: string, fingerprint: string, contractVersion: number): void {
  updateRuntimeStateEntry(memberId, {contractFingerprint: fingerprint, contractVersion, driftNotified: undefined});
}
export function markDriftNotified(memberId: string, version: number): void {
  updateRuntimeStateEntry(memberId, {driftNotified: version});
}
export function markStaleMounts(memberId: string, fields: string[]): void {
  const now = Date.now();
  repository().update(memberId, current => ({...current, staleMounts: {
    since: now, fields: [...new Set([...(current.staleMounts?.fields ?? []), ...fields])],
  }}), now);
}
export function clearStaleMounts(memberId: string): void {
  repository().update(memberId, current => current.staleMounts ? ({...current, staleMounts: undefined}) : undefined, Date.now());
}
export function clearRuntimeStateEntry(memberId: string): void { repository().clear(memberId); }
