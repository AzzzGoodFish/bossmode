// Migration: cleanup-member-overrides-v1
// 0.20 moved room-member config authority from room.json memberOverrides to the
// member registry (global bindings + scope overrides). The old location kept
// three classes of residue (fish approved full cleanup 2026-08-04):
//   1. mem_* entries from model switches made before F4 — post-F4 there is
//      NO legal write path that produces a mem_* memberOverrides key (F4
//      writes the registry), so every mem_* key is definitional residue
//      (re-switched since; the registry holds the real bindings)
//   2. codex-era name-keyed dead config (models no longer available)
//   3. entries whose live intent was already restored into the new authority
//      (e.g. qa playwright, restored by fish)
// For stamped rooms (globalMemberIds non-empty) the read side NEVER consults
// memberOverrides — every entry there is dead weight. Still, each entry is
// checked before deletion: an entry whose value is NOT reflected in the new
// authority and still looks like a live intent (e.g. an available model
// binding) is skipped + warned, never hard-cleared. Legacy unstamped rooms
// (empty globalMemberIds) still read memberOverrides as their only authority —
// those rooms are skipped entirely + warned.
// Idempotent by data state: no residue → no work. A marker is written for
// observability, never trusted as the skip condition.
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getMember, getEffectiveConfig } from "./member-registry.js";
import { isModelAvailable, listAvailableModels } from "../engine/model-credentials.js";
import type { RoomMemberOverride } from "../shared/types.js";

const MIGRATION_ID = "cleanup-member-overrides-v1";

/** Fields compared against the new authority. contextLimit has no registry
 * equivalent — its presence makes an entry suspicious (kept + warned). */
const COMPARED_FIELDS = ["model", "credentialId", "thinkingLevel", "skills", "extensions", "mcpServers"] as const;

export interface OverrideCleanupResult {
  roomsScanned: number;
  entriesRemoved: number;
  entriesKeptSuspicious: number;
  legacyRoomsSkipped: number;
}

function roomsRoot(): string {
  return join(getBossmodeDir(), "rooms");
}

function snapshotRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime", ".migration-snapshots", MIGRATION_ID);
}

function markerPath(): string {
  return join(getBossmodeDir(), ".migrations", `${MIGRATION_ID}.json`);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Is `level` offered by the given effective model? Judges against the
 * model's thinkingLevelMap (same metadata the switch path uses).
 * Conservative when there is nothing to judge against (no effective model,
 * model not in the available list, or no level metadata) — unknown = keep.
 */
function thinkingLevelOfferedByEffectiveModel(effectiveModel: string | null | undefined, level: unknown): boolean {
  if (typeof level !== "string" || !effectiveModel) return true;
  const option = listAvailableModels().find((m) => m.ref === effectiveModel);
  const map = option?.thinkingLevelMap;
  if (!map || Object.keys(map).length === 0) return true;
  return (map as Record<string, unknown>)[level] != null;
}

/** Resolve an override key (mem_* id or legacy member name) to a registry
 * member id within the room's stamped membership. Name matching stays inside
 * globalMemberIds (rename-safe, same rule as resolveGlobalMemberId). */
function resolveKeyToMemberId(key: string, globalMemberIds: string[]): string | null {
  if (key.startsWith("mem_")) return globalMemberIds.includes(key) ? key : null;
  for (const id of globalMemberIds) {
    const g = getMember(id);
    if (g && g.name === key) return g.id;
  }
  return null;
}

/**
 * Decide whether a NAME-keyed entry is dead residue. Returns null when
 * dead, or a human-readable reason when the entry looks like a live intent
 * that the new authority does not reflect (entry kept). mem_* keys never
 * reach here (definitional residue, handled by the caller).
 */
function suspiciousReason(entry: RoomMemberOverride, memberId: string, roomId: string): string | null {
  // An entry bound to an unavailable model is codex-era dead config as a
  // whole — every field in it belonged to that dead binding.
  if (typeof entry.model === "string" && entry.model && !isModelAvailable(entry.model)) return null;
  const effective = getEffectiveConfig(memberId, `room:${roomId}`);
  const reasons: string[] = [];
  for (const field of COMPARED_FIELDS) {
    if (!(field in entry) || (entry as Record<string, unknown>)[field] === undefined) continue;
    const value = (entry as Record<string, unknown>)[field];
    if (jsonEqual(value, effective[field])) continue; // dead duplicate of the new authority
    if (field === "model" && typeof value === "string" && !isModelAvailable(value)) continue; // codex-era dead config
    if (field === "credentialId" && typeof entry.model === "string" && !isModelAvailable(entry.model)) continue; // credential of a dead model binding
    if (field === "thinkingLevel" && !thinkingLevelOfferedByEffectiveModel(effective.model, value)) continue; // level the current model does not offer (e.g. codex xhigh on k3)
    reasons.push(`${field}=${JSON.stringify(value)} (effective: ${JSON.stringify(effective[field])})`);
  }
  if ("contextLimit" in entry && entry.contextLimit !== undefined) {
    reasons.push(`contextLimit=${JSON.stringify(entry.contextLimit)} (no registry equivalent)`);
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}

export function runMemberOverridesCleanupMigration(): OverrideCleanupResult {
  const result: OverrideCleanupResult = { roomsScanned: 0, entriesRemoved: 0, entriesKeptSuspicious: 0, legacyRoomsSkipped: 0 };
  const root = roomsRoot();
  if (!existsSync(root)) return result;

  for (const dirEntry of readdirSync(root, { withFileTypes: true })) {
    if (!dirEntry.isDirectory() || dirEntry.name.startsWith("dm:")) continue;
    const roomJsonPath = join(root, dirEntry.name, "room.json");
    if (!existsSync(roomJsonPath)) continue;
    result.roomsScanned++;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(roomJsonPath, "utf-8"));
    } catch (err) {
      logger.warn("migration", "cleanup-member-overrides: unreadable room.json, skipped", { roomId: dirEntry.name, error: String(err) });
      continue;
    }
    const overrides = raw.memberOverrides as Record<string, RoomMemberOverride> | undefined;
    if (!overrides || Object.keys(overrides).length === 0) continue;

    const globalMemberIds = Array.isArray(raw.globalMemberIds) ? (raw.globalMemberIds as string[]).filter(Boolean) : [];
    if (globalMemberIds.length === 0) {
      // Legacy unstamped room: memberOverrides is still the live read side.
      result.legacyRoomsSkipped++;
      logger.warn("migration", "cleanup-member-overrides: legacy unstamped room skipped (memberOverrides still authoritative)", {
        roomId: dirEntry.name,
        keys: Object.keys(overrides),
      });
      continue;
    }

    const kept: Record<string, RoomMemberOverride> = {};
    let removed = 0;
    for (const [key, entry] of Object.entries(overrides)) {
      // mem_* keys are definitional residue: post-F4 no write path produces
      // them, so whatever they contain was superseded by the registry.
      if (key.startsWith("mem_")) {
        removed++;
        continue;
      }
      const memberId = resolveKeyToMemberId(key, globalMemberIds);
      if (!memberId) {
        removed++; // ghost member — entry can never be read or intended
        continue;
      }
      const reason = suspiciousReason(entry || {}, memberId, dirEntry.name);
      if (reason) {
        kept[key] = entry;
        result.entriesKeptSuspicious++;
        logger.warn("migration", "cleanup-member-overrides: entry kept — looks like a live intent not in the new authority", {
          roomId: dirEntry.name,
          key,
          reason,
        });
      } else {
        removed++;
      }
    }
    if (removed === 0) continue;

    // Snapshot before any mutation, then write back.
    const snapDir = join(snapshotRoot(), dirEntry.name);
    mkdirSync(snapDir, { recursive: true });
    copyFileSync(roomJsonPath, join(snapDir, "room.json"));
    if (Object.keys(kept).length > 0) raw.memberOverrides = kept;
    else delete raw.memberOverrides;
    writeFileSync(roomJsonPath, JSON.stringify(raw, null, 2) + "\n");
    result.entriesRemoved += removed;
    logger.info("migration", "cleanup-member-overrides: residue cleared", {
      roomId: dirEntry.name,
      removed,
      kept: Object.keys(kept),
      snapshot: join(snapDir, "room.json"),
    });
  }

  if (result.entriesRemoved > 0 || result.entriesKeptSuspicious > 0 || result.legacyRoomsSkipped > 0) {
    mkdirSync(join(getBossmodeDir(), ".migrations"), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ appliedAt: new Date().toISOString(), ...result }, null, 2) + "\n");
  }
  return result;
}
