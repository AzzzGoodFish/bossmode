// DB-owned runtime recovery metadata. Module import never initializes storage.
// ① B8 / C3: runtime checkpoints are member-level — one entry per member,
// independent of the chat being served.
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

/** Member-id keyed map (all members with a checkpoint). */
export type RuntimeStateMap = Record<string, RuntimeStateEntry>;

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
