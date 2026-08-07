// Per-scope runtime state: contract fingerprint + mount-stale markers.
//
// Used by the auto-reload prompt system (fish 2026-08-07): a contract
// fingerprint lets the daemon detect "the build changed core tools/prompt"
// after a restart, and mount-stale markers track MCP/extension config changes
// that a running instance has not yet picked up.
//
// Storage: rooms/<id>/runtime-state.json for room scope, members/<id>/
// runtime-state.json for DM scope. Corrupt/missing → treated as empty (quiet
// fallback, never blocks startup — see spec §5).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseScopeId } from "../shared/conversation-ref.js";
import { getBossmodeDir } from "../shared/config.js";

export interface MountStale {
  since: number;
  /** Which mount field(s) changed: "mcpServers" | "extensions". */
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

function stateFilePath(scopeId: string): string {
  const ref = parseScopeId(scopeId);
  if (!ref) throw new Error(`scope_not_found: ${scopeId}`);
  if (ref.kind === "dm") return join(getBossmodeDir(), "members", ref.memberId, "runtime-state.json");
  return join(getBossmodeDir(), "rooms", ref.roomId, "runtime-state.json");
}

function stateKey(scopeId: string, memberId: string): string {
  return `${scopeId}:${memberId}`;
}

export function readRuntimeState(scopeId: string): RuntimeStateMap {
  const path = stateFilePath(scopeId);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return (data && typeof data === "object") ? data as RuntimeStateMap : {};
  } catch {
    return {};
  }
}

function writeRuntimeState(scopeId: string, state: RuntimeStateMap): void {
  const path = stateFilePath(scopeId);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function getRuntimeStateEntry(scopeId: string, memberId: string): RuntimeStateEntry {
  return readRuntimeState(scopeId)[stateKey(scopeId, memberId)] ?? {};
}

export function updateRuntimeStateEntry(scopeId: string, memberId: string, patch: RuntimeStateEntry): void {
  const state = readRuntimeState(scopeId);
  const key = stateKey(scopeId, memberId);
  state[key] = { ...state[key], ...patch };
  writeRuntimeState(scopeId, state);
}

export function setContractFingerprint(scopeId: string, memberId: string, fingerprint: string, contractVersion: number): void {
  const entry = getRuntimeStateEntry(scopeId, memberId);
  // Refreshing the fingerprint clears any pending contract drift notification.
  updateRuntimeStateEntry(scopeId, memberId, { ...entry, contractFingerprint: fingerprint, contractVersion, driftNotified: undefined });
}

export function markDriftNotified(scopeId: string, memberId: string, version: number): void {
  const entry = getRuntimeStateEntry(scopeId, memberId);
  updateRuntimeStateEntry(scopeId, memberId, { ...entry, driftNotified: version });
}

export function markStaleMounts(scopeId: string, memberId: string, fields: string[]): void {
  const entry = getRuntimeStateEntry(scopeId, memberId);
  const existing = entry.staleMounts;
  const mergedFields = [...new Set([...(existing?.fields ?? []), ...fields])];
  updateRuntimeStateEntry(scopeId, memberId, { ...entry, staleMounts: { since: Date.now(), fields: mergedFields } });
}

export function clearStaleMounts(scopeId: string, memberId: string): void {
  const state = readRuntimeState(scopeId);
  const key = stateKey(scopeId, memberId);
  if (!state[key]?.staleMounts) return;
  delete state[key].staleMounts;
  writeRuntimeState(scopeId, state);
}

/** Clear all state for a member in a scope (after reset). */
export function clearRuntimeStateEntry(scopeId: string, memberId: string): void {
  const state = readRuntimeState(scopeId);
  const key = stateKey(scopeId, memberId);
  if (!(key in state)) return;
  delete state[key];
  writeRuntimeState(scopeId, state);
}
