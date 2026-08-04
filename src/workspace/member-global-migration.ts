/**
 * 0.19 → 0.20 member-global migration (one-shot, idempotent).
 * Snapshots legacy tree to backups/legacy-0.19-<ts>/, builds manifest by name,
 * creates global members/, seeds persona from newest principles, stamps room.globalMemberIds.
 * Does NOT delete roomMembers yet (dual-read until WS-B cuts over).
 * Contract §7.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "./room-store.js";
import {
  createMember,
  findMemberByName,
  listMembers,
  type MemberRecord,
} from "./member-registry.js";
import { ensureMemorySkeleton, writeMemoryLayer } from "./member-memory-store.js";

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

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
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
      const principlesPath = join(roomStore.roomDir(room.id), "memory", "members", rm.id, "principles.md");
      const mainlinePath = join(roomStore.roomDir(room.id), "memory", "members", rm.id, "mainline.md");
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

function pickNewestPrinciples(instances: ManifestMember[]): string {
  const withPrin = instances
    .filter((i) => i.principlesPath && existsSync(i.principlesPath))
    .sort((a, b) => (b.principlesMtime || 0) - (a.principlesMtime || 0));
  if (withPrin.length === 0) return "";
  return safeRead(withPrin[0].principlesPath!);
}

/**
 * Run once per bossmode dir. Safe to call every startup.
 */
export function runMemberGlobalMigration(): {
  skipped: boolean;
  archivePath?: string;
  createdMembers: number;
  roomsStamped: number;
} {
  const existing = readMarker();
  if (existing?.done) {
    return { skipped: true, archivePath: existing.archivePath, createdMembers: 0, roomsStamped: 0 };
  }

  // Already have global members and no rooms? still mark done lightly
  const boss = getBossmodeDir();
  if (!existsSync(boss)) {
    writeMarker({ done: true, at: Date.now(), note: "no bossmode dir" });
    return { skipped: true, createdMembers: 0, roomsStamped: 0 };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRel = join("backups", `legacy-0.19-${ts}`);
  const archiveAbs = join(boss, archiveRel);
  mkdirSync(archiveAbs, { recursive: true });

  // Snapshot
  copyIfExists(join(boss, "rooms"), join(archiveAbs, "rooms"));
  copyIfExists(join(boss, "pi-agent", "runtime"), join(archiveAbs, "pi-agent-runtime"));
  copyIfExists(join(boss, "agents"), join(archiveAbs, "agents"));

  const manifest = collectManifest();
  // Enrich manifest for archive-list (rooms per name)
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
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  let createdMembers = 0;
  const nameToGlobalId = new Map<string, string>();

  for (const [name, instances] of byName) {
    const existingMem = findMemberByName(name);
    if (existingMem) {
      nameToGlobalId.set(name, existingMem.id);
      continue;
    }
    const canon = pickCanonical(instances);
    try {
      const rec = createMember({
        name,
        agentTemplate: canon.sourceAgent || "general",
        model: canon.config?.model ?? null,
        credentialId: canon.config?.credentialId ?? null,
        thinkingLevel: canon.config?.thinkingLevel ?? null,
      });
      nameToGlobalId.set(name, rec.id);
      createdMembers += 1;
      const persona = pickNewestPrinciples(instances);
      ensureMemorySkeleton(rec.id);
      if (persona.trim()) {
        writeMemoryLayer(rec.id, "persona", persona, { type: "user" }, { reason: "member-global-v1 migration" });
      }
    } catch (err) {
      logger.error("migration", "failed to create global member", { name, error: String(err) });
    }
  }

  // Stamp room.globalMemberIds (and promptLeaderGlobalMemberId if resolvable)
  let roomsStamped = 0;
  for (const room of roomStore.listRooms()) {
    try {
      const roomMembers = roomStore.getRoomMembers(room.id);
      const globalIds = roomMembers
        .map((rm) => nameToGlobalId.get(rm.name))
        .filter((id): id is string => !!id);
      const leaderName = roomMembers.find((rm) => rm.id === room.promptLeaderMemberId)?.name;
      const leaderGlobalId = leaderName ? nameToGlobalId.get(leaderName) : undefined;
      roomStore.stampGlobalMemberIds(room.id, globalIds, leaderGlobalId);
      roomsStamped += 1;
    } catch (err) {
      logger.error("migration", "failed to stamp room globalMemberIds", { roomId: room.id, error: String(err) });
    }
  }

  writeMarker({
    done: true,
    at: Date.now(),
    archivePath: archiveRel,
    createdMembers,
    roomsStamped,
    memberCount: listMembers().length,
  });

  logger.info("migration", "member-global-v1 complete", {
    archivePath: archiveRel,
    createdMembers,
    roomsStamped,
    conflicts: manifest.conflicts.length,
  });

  return { skipped: false, archivePath: archiveRel, createdMembers, roomsStamped };
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

export type { MemberRecord };
