// Migration: member-credential-binding-v1
// Clears the pre-v1 "bare model, no credential" intermediate state that let Bossmode
// implicitly guess a provider/credential at request time. After this migration, a
// member either has an explicit {model, credentialId} pair or is Unconfigured — never
// a model without a bound credential.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../kernel/logger.js";
import { getRoomsDir, roomDir } from "../files/layout.js";
import type { Room, RoomMemberRecord } from "../kernel/types.js";

const MIGRATION_ID = "member-credential-binding-v1";

function migrationsRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

function markerPath(): string {
  return join(migrationsRoot(), ".migrations", `${MIGRATION_ID}.json`);
}

function snapshotDir(): string {
  return join(migrationsRoot(), ".migration-snapshots");
}

interface MigrationMarker {
  rooms: Record<string, boolean>;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function readMarker(): MigrationMarker {
  const marker = readJson<Partial<MigrationMarker>>(markerPath(), {});
  return { rooms: marker.rooms || {} };
}

function writeMarker(marker: MigrationMarker): void {
  writeJson(markerPath(), { migration: MIGRATION_ID, ...marker, updatedAt: Date.now() });
}

function snapshotFile(sourcePath: string, label: string): void {
  if (!existsSync(sourcePath)) return;
  const target = join(snapshotDir(), `${MIGRATION_ID}-${label}-${Date.now()}.json`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(sourcePath, target);
}

/** A member is in the defective intermediate state if it has a model but no bound credential. */
function needsClearing(model: string | undefined, credentialId: string | undefined): boolean {
  return Boolean(model) && !credentialId;
}

function clearRoomMemberConfig(member: RoomMemberRecord): boolean {
  if (!member.config) return false;
  if (!needsClearing(member.config.model, member.config.credentialId)) return false;
  const { model: _model, credentialId: _credentialId, ...rest } = member.config;
  member.config = Object.keys(rest).length > 0 ? rest : undefined;
  return true;
}

function migrateRoom(roomId: string): number {
  const path = join(roomDir(roomId), "room.json");
  const room = readJson<Room | null>(path, null);
  if (!room || Array.isArray(room.globalMemberIds) || !Array.isArray(room.roomMembers) || room.roomMembers.length === 0) return 0;

  let changed = 0;
  for (const member of room.roomMembers) {
    if (clearRoomMemberConfig(member)) changed += 1;
  }
  if (changed > 0) {
    snapshotFile(path, `room-${roomId}`);
    writeJson(path, room);
  }
  return changed;
}

export function runMemberCredentialBindingMigration(): void {
  const marker = readMarker();

  // Legacy configuration was materialized into room records by the preceding
  // room migration. Never reread or rewrite the retired global registry.
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;

  for (const entry of readdirSync(roomsDir)) {
    if (marker.rooms[entry] === true) continue;
    try {
      const changed = migrateRoom(entry);
      if (changed > 0) logger.info("member-credential-binding-migration", "cleared unconfigured room members", { roomId: entry, changed });
    } catch (err) {
      logger.error("member-credential-binding-migration", "failed to migrate room", { roomId: entry, error: String(err) });
    }
    marker.rooms[entry] = true;
    writeMarker(marker);
  }
}
