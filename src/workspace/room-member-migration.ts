import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../foundation/logger.js";
import * as roomStore from "./room-store.js";
import { getBossmodeDir } from "../shared/config.js";
import type { AgentMemberConfig, AgentSession, CursorMap, LegacyMemberConfig, Room, RoomMemberConfig, RoomMemberRecord } from "../shared/types.js";

function roomJsonPath(roomId: string): string {
  return join((roomStore as any).roomDir(roomId), "room.json");
}

function cursorsPath(roomId: string): string {
  return join((roomStore as any).roomDir(roomId), "cursors.json");
}

function sessionsPath(roomId: string): string {
  return join((roomStore as any).roomDir(roomId), "sessions.json");
}

function eventsDir(roomId: string): string {
  return join((roomStore as any).roomDir(roomId), "agent-events");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function piRuntimeRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function runtimeMemberDir(roomId: string, memberRef: string): string {
  return join(piRuntimeRoot(), roomId, safeSegment(memberRef));
}

const MEMBER_RUNTIME_MIGRATION_ID = "member-runtime-unified-v3";

function migrationMarkerPath(): string {
  return join(piRuntimeRoot(), ".migrations", `${MEMBER_RUNTIME_MIGRATION_ID}.json`);
}

function readMigrationMarker(): { rooms: Record<string, boolean> } {
  const marker = readJson<{ rooms?: Record<string, boolean> }>(migrationMarkerPath(), { rooms: {} });
  return { rooms: marker.rooms || {} };
}

function writeMigrationMarkerRoom(roomId: string, marker: { rooms: Record<string, boolean> }): void {
  marker.rooms = { ...marker.rooms, [roomId]: true };
  writeJson(migrationMarkerPath(), { migration: MEMBER_RUNTIME_MIGRATION_ID, rooms: marker.rooms, updatedAt: Date.now() });
}

function snapshotRuntimeRoom(roomId: string): string | null {
  const source = join(piRuntimeRoot(), roomId);
  if (!existsSync(source)) return null;
  const target = join(piRuntimeRoot(), ".migration-snapshots", `${MEMBER_RUNTIME_MIGRATION_ID}-${roomId}-${Date.now()}`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
  return target;
}

function copyRuntimeTreeMissing(source: string, target: string): number {
  if (!existsSync(source)) return 0;
  let copied = 0;
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
    return 1;
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copied += copyRuntimeTreeMissing(from, to);
    else if (!existsSync(to)) {
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

function migrateRuntimeMemberDirs(room: Room): number {
  const members = room.roomMembers || [];
  let copied = 0;
  let snapshotted = false;
  for (const member of members) {
    const legacyName = member.migratedFrom?.memberName || member.name;
    if (legacyName === member.id) continue;
    const source = runtimeMemberDir(room.id, legacyName);
    const target = runtimeMemberDir(room.id, member.id);
    if (existsSync(source)) {
      if (!snapshotted) {
        snapshotRuntimeRoom(room.id);
        snapshotted = true;
      }
      copied += copyRuntimeTreeMissing(source, target);
      rmSync(source, { recursive: true, force: true });
      copied += 1;
    }
  }
  return copied;
}

function cleanConfig(config: RoomMemberConfig): RoomMemberConfig {
  const next: RoomMemberConfig = {};
  if (config.model) next.model = config.model;
  if (config.credentialId) next.credentialId = config.credentialId;
  if (config.thinkingLevel) next.thinkingLevel = config.thinkingLevel;
  if (typeof config.contextLimit === "number" && Number.isFinite(config.contextLimit)) next.contextLimit = config.contextLimit;
  if (Array.isArray(config.skills) && config.skills.length > 0) next.skills = Array.from(new Set(config.skills.filter(Boolean)));
  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0) next.mcpServers = Array.from(new Set(config.mcpServers.filter(Boolean)));
  return next;
}

function normalizeLegacyMember(raw: LegacyMemberConfig | AgentMemberConfig): AgentMemberConfig {
  return {
    id: raw.id,
    name: raw.name,
    type: "agent",
    agent: raw.agent,
    model: raw.model,
    runtime: "pi-cli",
    thinkingLevel: raw.thinkingLevel,
    avatar: raw.avatar,
    contextLimit: raw.contextLimit,
    credentialId: raw.credentialId,
    skills: raw.skills,
  };
}

function loadLegacyMembers(): AgentMemberConfig[] {
  const roomsDir = "getRoomsDir" in roomStore ? (roomStore as any).getRoomsDir() : null;
  if (!roomsDir) return [];
  const membersPath = join(roomsDir, "..", "members.json");
  const raw = readJson<Array<LegacyMemberConfig | AgentMemberConfig>>(membersPath, []);
  return Array.isArray(raw) ? raw.map(normalizeLegacyMember) : [];
}

function createMigratedMember(roomId: string, memberName: string, room: Room, legacyMembers: AgentMemberConfig[]): RoomMemberRecord {
  const legacyMember = legacyMembers.find((member) => member.name === memberName);
  const override = room.memberOverrides?.[memberName] || {};
  const config = cleanConfig({
    model: legacyMember?.model,
    credentialId: legacyMember?.credentialId,
    thinkingLevel: legacyMember?.thinkingLevel,
    contextLimit: legacyMember?.contextLimit,
    skills: legacyMember?.skills,
    ...override,
  });
  const now = Date.now();
  return {
    id: `rm_${randomUUID()}`,
    roomId,
    name: memberName,
    sourceAgent: legacyMember?.agent || memberName,
    sourceMemberId: legacyMember?.id,
    avatar: legacyMember?.avatar,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    createdAt: now,
    updatedAt: now,
    migratedFrom: { memberName, memberId: legacyMember?.id },
  };
}

function migrateKeyedJson<T>(path: string, mappings: Array<{ name: string; id: string }>): number {
  const data = readJson<Record<string, T>>(path, {});
  let copied = 0;
  for (const { name, id } of mappings) {
    if (data[id] === undefined && data[name] !== undefined) {
      data[id] = data[name];
      copied += 1;
    }
    if (name !== id && data[name] !== undefined) {
      delete data[name];
      copied += 1;
    }
  }
  if (copied > 0) writeJson(path, data);
  return copied;
}

function remapLegacyRuntimePath(path: string, roomId: string, legacyName: string, memberId: string): string | null {
  if (!isAbsolute(path)) return null;
  const rel = relative(runtimeMemberDir(roomId, legacyName), path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return join(runtimeMemberDir(roomId, memberId), rel);
}

function repairMigratedSessionFile(roomId: string, mapping: { name: string; id: string }, session: AgentSession): AgentSession {
  if (!session.sessionFile) return session;
  const remapped = remapLegacyRuntimePath(session.sessionFile, roomId, mapping.name, mapping.id);
  if (remapped && remapped !== session.sessionFile && existsSync(remapped)) {
    return { ...session, sessionFile: remapped };
  }
  if (!existsSync(session.sessionFile)) {
    const { sessionFile: _missingSessionFile, ...withoutMissingSessionFile } = session;
    return withoutMissingSessionFile;
  }
  return session;
}

function migrateSessions(roomId: string, mappings: Array<{ name: string; id: string }>): number {
  const path = sessionsPath(roomId);
  const data = readJson<Record<string, AgentSession>>(path, {});
  let changed = 0;
  for (const mapping of mappings) {
    const { name, id } = mapping;
    const current = data[id] ?? data[name];
    if (current !== undefined) {
      const next = repairMigratedSessionFile(roomId, mapping, current);
      if (data[id] === undefined || JSON.stringify(data[id]) !== JSON.stringify(next)) {
        data[id] = next;
        changed += 1;
      }
    }
    if (name !== id && data[name] !== undefined) {
      delete data[name];
      changed += 1;
    }
  }
  if (changed > 0) writeJson(path, data);
  return changed;
}

function migrateAgentEvents(roomId: string, mappings: Array<{ name: string; id: string }>): number {
  const dir = eventsDir(roomId);
  if (!existsSync(dir)) return 0;
  let copied = 0;
  for (const { name, id } of mappings) {
    const oldPath = join(dir, `${name}.jsonl`);
    const newPath = join(dir, `${id}.jsonl`);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      copyFileSync(oldPath, newPath);
      copied += 1;
    }
  }
  return copied;
}

function ensurePersistenceKeys(room: Room): { cursors: number; sessions: number; events: number } {
  const members = room.roomMembers || [];
  const mappings = members.map((member) => ({ name: member.migratedFrom?.memberName || member.name, id: member.id }));
  return {
    cursors: migrateKeyedJson<string | null>(cursorsPath(room.id), mappings),
    sessions: migrateSessions(room.id, mappings),
    events: migrateAgentEvents(room.id, mappings),
  };
}

export function runRoomMemberMigration(): void {
  const roomsDir = "getRoomsDir" in roomStore ? (roomStore as any).getRoomsDir() : null;
  if (!roomsDir || !existsSync(roomsDir)) return;

  for (const entry of readdirSync(roomsDir)) {
    const path = roomJsonPath(entry);
    if (!existsSync(path)) continue;
    try {
      const room = readJson<Room | null>(path, null);
      if (!room || Array.isArray(room.globalMemberIds)) continue; // Current membership (including empty) is authoritative.
      let created = 0;
      if (!Array.isArray(room.roomMembers) || room.roomMembers.length === 0) {
        const names = Array.isArray(room.members) ? room.members : [];
        const legacyMembers = loadLegacyMembers();
        room.roomMembers = names.map((name) => createMigratedMember(room.id, name, room, legacyMembers));
        room.members = room.roomMembers.map((member) => member.name);
        created = room.roomMembers.length;
        writeJson(path, room);
      } else {
        room.roomMembers = room.roomMembers.map((member) => ({ ...member, roomId: member.roomId || room.id }));
        const nextNames = room.roomMembers.map((member) => member.name);
        if (JSON.stringify(room.members || []) !== JSON.stringify(nextNames)) {
          room.members = nextNames;
          writeJson(path, room);
        }
      }

      const marker = readMigrationMarker();
      const migrationDone = marker.rooms[room.id] === true;
      const runtimeDirs = migrationDone ? 0 : migrateRuntimeMemberDirs(room);
      const persistence = migrationDone ? { cursors: 0, sessions: 0, events: 0 } : ensurePersistenceKeys(room);
      if (!migrationDone) writeMigrationMarkerRoom(room.id, marker);
      if (created > 0 || persistence.cursors > 0 || persistence.sessions > 0 || persistence.events > 0 || runtimeDirs > 0) {
        logger.info("room-member-migration", "room migrated", { roomId: room.id, created, ...persistence, runtimeDirs });
      }
    } catch (err) {
      logger.error("room-member-migration", "failed to migrate room", { roomId: entry, error: String(err) });
    }
  }
}
