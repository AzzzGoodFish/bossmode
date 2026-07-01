import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../foundation/logger.js";
import * as roomStore from "./room-store.js";
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
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
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
  }
  if (copied > 0) writeJson(path, data);
  return copied;
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
    sessions: migrateKeyedJson<AgentSession>(sessionsPath(room.id), mappings),
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
      if (!room) continue;
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

      const persistence = ensurePersistenceKeys(room);
      if (created > 0 || persistence.cursors > 0 || persistence.sessions > 0 || persistence.events > 0) {
        logger.info("room-member-migration", "room migrated", { roomId: room.id, created, ...persistence });
      }
    } catch (err) {
      logger.error("room-member-migration", "failed to migrate room", { roomId: entry, error: String(err) });
    }
  }
}
