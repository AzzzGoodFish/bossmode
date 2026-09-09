// DB-owned runtime recovery metadata. Module import never initializes storage.
import { getDatabase } from "../storage/database.js";
import { RuntimeRepository } from "../storage/repositories/runtime-repository.js";

export interface MountStale {
  since: number;
  /** Which mount field(s) changed (currently only "mcpServers"). */
  fields: string[];
}

export interface RuntimeStateEntry {
  /** sha1 of bossmode-core + environment-communication + tool schema — code-owned contract parts only. */
  contractFingerprint?: string;
  /** Member-facing contract version stored at last compile (drives the startup drift dialog). */
  contractVersion?: number;
  /** Last version the user was notified about (one-shot drift guard). */
  driftNotified?: number;
  /** Mount config changed since last reload/reset; instance still runs the old mounts. */
  staleMounts?: MountStale;
}

export type RuntimeStateMap = Record<string, RuntimeStateEntry>;

function repository(): RuntimeRepository { return new RuntimeRepository(getDatabase()); }

export function readRuntimeState(scopeId: string): RuntimeStateMap { return repository().list(scopeId); }
export function getRuntimeStateEntry(scopeId: string, memberId: string): RuntimeStateEntry { return repository().get(scopeId, memberId); }
export function updateRuntimeStateEntry(scopeId: string, memberId: string, patch: RuntimeStateEntry): void {
  repository().update(scopeId, memberId, current => ({...current, ...patch}), Date.now());
}
export function setContractFingerprint(scopeId: string, memberId: string, fingerprint: string, contractVersion: number): void {
  updateRuntimeStateEntry(scopeId, memberId, {contractFingerprint: fingerprint, contractVersion, driftNotified: undefined});
}
export function markDriftNotified(scopeId: string, memberId: string, version: number): void {
  updateRuntimeStateEntry(scopeId, memberId, {driftNotified: version});
}
export function markStaleMounts(scopeId: string, memberId: string, fields: string[]): void {
  const now = Date.now();
  repository().update(scopeId, memberId, current => ({...current, staleMounts: {
    since: now, fields: [...new Set([...(current.staleMounts?.fields ?? []), ...fields])],
  }}), now);
}
export function clearStaleMounts(scopeId: string, memberId: string): void {
  repository().update(scopeId, memberId, current => current.staleMounts ? ({...current, staleMounts: undefined}) : undefined, Date.now());
}
export function clearRuntimeStateEntry(scopeId: string, memberId: string): void { repository().clear(scopeId, memberId); }
