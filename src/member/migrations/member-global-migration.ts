/**
 * 0.19 → 0.20 member-global migration (one-shot, idempotent).
 * fish-confirmed (2026-08-04, msg 14161/14167): FULL automatic migration —
 * global members are created (name-aggregated), rooms stamped usable,
 * memory re-homed. Archive snapshot stays as non-destructive fallback;
 * "import from archive" remains the recovery path.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../../shared/config.js";
import { logger } from "../../kernel/logger.js";
import * as roomStore from "../../chat/room-store.js";
import { roomDir } from "../../files/layout.js";
import { createMember, findMemberByName } from "../member-registry.js";
import { ensureMemorySkeleton, writeMemoryLayer } from "../member-memory-store.js";
import { scopeIdOf } from "../../shared/conversation-ref.js";

const MIGRATION_ID = "member-global-v1";

function markerPath(): string {
  return join(getBossmodeDir(), ".migrations", `${MIGRATION_ID}.json`);
}

function readMarker(): { done?: boolean; archivePath?: string; at?: number } | null {
  const p = markerPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeMarker(data: Record<string, unknown>): void {
  const dir = join(getBossmodeDir(), ".migrations");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(), JSON.stringify({ migration: MIGRATION_ID, ...data }, null, 2) + "\n", "utf-8");
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
  return true;
}

interface ManifestMember {
  name: string;
  sourceAgent: string;
  memberId: string; // legacy room member id
  roomId: string;
  roomName: string;
  config?: { model?: string; credentialId?: string; thinkingLevel?: string };
  principlesPath?: string;
  mainlinePath?: string;
  principlesMtime?: number;
  updatedAt?: number;
}

interface Manifest {
  ts: number;
  rooms: Array<{ id: string; name: string }>;
  members: ManifestMember[];
  conflicts: Array<{ name: string; detail: string }>;
}

function collectManifest(): Manifest {
  const rooms = roomStore.listRooms();
  const members: ManifestMember[] = [];
  const conflicts: Array<{ name: string; detail: string }> = [];

  for (const room of rooms) {
    const roomMembers = roomStore.getRoomMembers(room.id);
    for (const rm of roomMembers) {
      const principlesPath = join(roomDir(room.id), "memory", "members", rm.id, "principles.md");
      const mainlinePath = join(roomDir(room.id), "memory", "members", rm.id, "mainline.md");
      let principlesMtime = 0;
      if (existsSync(principlesPath)) {
        try {
          principlesMtime = statSync(principlesPath).mtimeMs;
        } catch { /* ignore */ }
      }
      members.push({
        name: rm.name,
        sourceAgent: rm.sourceAgent || rm.name,
        memberId: rm.id,
        roomId: room.id,
        roomName: room.name,
        config: rm.config
          ? {
              model: rm.config.model,
              credentialId: rm.config.credentialId,
              thinkingLevel: rm.config.thinkingLevel,
            }
          : undefined,
        principlesPath: existsSync(principlesPath) ? principlesPath : undefined,
        mainlinePath: existsSync(mainlinePath) ? mainlinePath : undefined,
        principlesMtime,
        updatedAt: rm.updatedAt || rm.createdAt || 0,
      });
    }
  }

  // Detect same name different sourceAgent
  const byName = new Map<string, ManifestMember[]>();
  for (const m of members) {
    const list = byName.get(m.name) || [];
    list.push(m);
    byName.set(m.name, list);
  }
  for (const [name, list] of byName) {
    const agents = new Set(list.map((m) => m.sourceAgent));
    if (agents.size > 1) {
      conflicts.push({
        name,
        detail: `multiple sourceAgent values: ${[...agents].join(", ")} — using newest updatedAt`,
      });
    }
  }

  return {
    ts: Date.now(),
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    members,
    conflicts,
  };
}

function pickCanonical(instances: ManifestMember[]): ManifestMember {
  return [...instances].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.principlesMtime || 0) - (a.principlesMtime || 0))[0];
}

function newestPrinciplesContent(instances: ManifestMember[]): string {
  const withPrin = instances
    .filter((i) => i.principlesPath && existsSync(i.principlesPath))
    .sort((a, b) => (b.principlesMtime || 0) - (a.principlesMtime || 0));
  if (withPrin.length === 0) return "";
  try {
    return readFileSync(withPrin[0].principlesPath!, "utf-8");
  } catch {
    return "";
  }
}

function readIfExists(path?: string): string {
  if (!path || !existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Every-startup, data-state-driven room stamp repair (F1, 2026-08-04).
 * The one-shot marker can lie: rc.2-era builds wrote `done` before the
 * stamping code existed, leaving rooms with members but no globalMemberIds —
 * the Members API then returns []. Markers are not consulted here: a room
 * whose stamp is missing/empty while its members resolve by name in the
 * registry gets (re)stamped. Stamping itself is idempotent, and rooms whose
 * data already says "stamped" are never touched. Poisoned states self-heal
 * on the first startup with this code — no restart, no marker reset.
 */
export function repairRoomGlobalMemberStamps(): number {
  let repaired = 0;
  for (const room of roomStore.listRooms()) {
    try {
      // Data says stamped — trust the data, not the marker.
      if (Array.isArray(room.globalMemberIds) && room.globalMemberIds.length > 0) continue;
      const roomMembers = roomStore.getRoomMembers(room.id);
      if (roomMembers.length === 0) continue; // genuinely empty room
      // All-or-nothing: stamping is an authoritative replace that drops
      // roomMembers — a member that fails to resolve would be silently
      // delisted. Skip and warn instead; the next startup (or a human) retries.
      const unresolved = roomMembers.filter((rm) => !findMemberByName(rm.name));
      if (unresolved.length > 0) {
        logger.warn("migration", "room stamp repair skipped: unresolved member names", {
          roomId: room.id,
          unresolved: unresolved.map((rm) => rm.name),
        });
        continue;
      }
      const globalIds = roomMembers.map((rm) => findMemberByName(rm.name)!.id);
      const leaderName = roomMembers.find((rm) => rm.id === room.promptLeaderMemberId)?.name;
      const leaderGlobalId = leaderName ? findMemberByName(leaderName)?.id : undefined;
      roomStore.stampGlobalMemberIds(room.id, globalIds, leaderGlobalId);
      repaired += 1;
      logger.info("migration", "room global-member stamp repaired (data-driven)", {
        roomId: room.id,
        members: globalIds.length,
      });
    } catch (err) {
      logger.error("migration", "failed to repair room stamp", { roomId: room.id, error: String(err) });
    }
  }
  return repaired;
}

/**
 * Run once per bossmode dir. Safe to call every startup.
 */
export function runMemberGlobalMigration(): {
  skipped: boolean;
  archivePath?: string;
  createdMembers: number;
  roomsStamped: number;
  mainlinesMoved: number;
  conflicts: number;
} {
  // Data-driven stamp repair runs every startup, marker or not (F1).
  repairRoomGlobalMemberStamps();

  const existing = readMarker();
  if (existing?.done) {
    return { skipped: true, archivePath: existing.archivePath, createdMembers: 0, roomsStamped: 0, mainlinesMoved: 0, conflicts: 0 };
  }

  const boss = getBossmodeDir();
  if (!existsSync(boss)) {
    writeMarker({ done: true, at: Date.now(), note: "no bossmode dir" });
    return { skipped: true, createdMembers: 0, roomsStamped: 0, mainlinesMoved: 0, conflicts: 0 };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRel = join("backups", `legacy-0.19-${ts}`);
  const archiveAbs = join(boss, archiveRel);
  mkdirSync(archiveAbs, { recursive: true });

  // 1) Non-destructive snapshot (fallback path — never touched again).
  copyIfExists(join(boss, "rooms"), join(archiveAbs, "rooms"));
  copyIfExists(join(boss, "pi-agent", "runtime"), join(archiveAbs, "pi-agent-runtime"));
  copyIfExists(join(boss, "agents"), join(archiveAbs, "agents"));

  // 2) Manifest (by-name aggregation + conflicts).
  const manifest = collectManifest();
  const byName = new Map<string, ManifestMember[]>();
  for (const m of manifest.members) {
    const list = byName.get(m.name) || [];
    list.push(m);
    byName.set(m.name, list);
  }
  const archiveMembers = [...byName.entries()].map(([name, instances]) => {
    const canon = pickCanonical(instances);
    return {
      name,
      sourceAgent: canon.sourceAgent,
      credentialId: canon.config?.credentialId,
      principlesPath: [...instances]
        .filter((i) => i.principlesPath)
        .sort((a, b) => (b.principlesMtime || 0) - (a.principlesMtime || 0))[0]?.principlesPath,
      rooms: instances.map((i) => ({
        room: i.roomName,
        roomId: i.roomId,
        hasPrinciples: !!i.principlesPath,
        hasMainline: !!i.mainlinePath,
      })),
      conflicts: manifest.conflicts.filter((c) => c.name === name).map((c) => c.detail),
    };
  });
  writeFileSync(
    join(archiveAbs, "manifest.json"),
    JSON.stringify(
      {
        ts: manifest.ts,
        rooms: manifest.rooms,
        members: archiveMembers,
        conflicts: manifest.conflicts,
        rawInstances: manifest.members,
        note: "Snapshot + manifest. Members were auto-created on upgrade; archive kept for recovery.",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  // 3) Auto-create global members (name aggregation, credential binding, persona seed).
  let createdMembers = 0;
  let mainlinesMoved = 0;
  for (const [name, instances] of byName) {
    const canon = pickCanonical(instances);
    let rec = findMemberByName(name);
    if (!rec) {
      try {
        rec = createMember({
          name,
          agentTemplate: canon.sourceAgent || "general",
          model: canon.config?.model ?? null,
          credentialId: canon.config?.credentialId ?? null,
          thinkingLevel: canon.config?.thinkingLevel ?? null,
        });
        createdMembers += 1;
      } catch (err) {
        logger.error("migration", "failed to create global member", { name, error: String(err) });
        continue;
      }
    }

    // Persona seed: newest member principles across this name's instances.
    try {
      const persona = newestPrinciplesContent(instances);
      ensureMemorySkeleton(rec.id);
      if (persona.trim()) {
        writeMemoryLayer(rec.id, "persona", persona, { type: "user" }, { reason: "member-global-v1 migration" });
      }
    } catch (err) {
      logger.error("migration", "persona seed failed", { name, error: String(err) });
    }

    // Per-room member mainline → (member, room) scope mainline.
    for (const inst of instances) {
      const content = readIfExists(inst.mainlinePath);
      if (!content.trim()) continue;
      try {
        const scopeId = scopeIdOf({ kind: "room", roomId: inst.roomId });
        ensureMemorySkeleton(rec.id, scopeId);
        writeMemoryLayer(rec.id, "mainline", content, { type: "user" }, { scopeId, reason: "member-global-v1 migration" });
        mainlinesMoved += 1;
      } catch (err) {
        logger.error("migration", "scope mainline move failed", { name, roomId: inst.roomId, error: String(err) });
      }
    }
  }

  // 4) Stamp rooms (globalMemberIds + leader + sourceMemberId links + cursor rekey).
  // Same data-driven repair that runs at every startup — after creation the
  // registry holds every name, so this stamps all legacy rooms.
  const roomsStamped = repairRoomGlobalMemberStamps();

  writeMarker({
    done: true,
    at: Date.now(),
    archivePath: archiveRel,
    createdMembers,
    roomsStamped,
    mainlinesMoved,
    conflicts: manifest.conflicts.length,
  });

  logger.info("migration", "member-global-v1 complete", {
    archivePath: archiveRel,
    createdMembers,
    roomsStamped,
    mainlinesMoved,
    conflicts: manifest.conflicts.length,
  });

  return {
    skipped: false,
    archivePath: archiveRel,
    createdMembers,
    roomsStamped,
    mainlinesMoved,
    conflicts: manifest.conflicts.length,
  };
}

/** Test helper */
export function __resetMigrationMarkerForTests(): void {
  const p = markerPath();
  if (existsSync(p)) {
    try {
      writeFileSync(p, JSON.stringify({ done: false }, null, 2));
    } catch { /* ignore */ }
  }
}
