import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import type { Room, CursorMap } from "../shared/types.js";

const ROOMS_DIR = join(getBossmodeDir(), "rooms");

export function getRoomsDir(): string {
  return ROOMS_DIR;
}

function ensureRoomsDir(): void {
  if (!existsSync(ROOMS_DIR)) {
    mkdirSync(ROOMS_DIR, { recursive: true });
  }
}

export function roomDir(roomId: string): string {
  return join(ROOMS_DIR, roomId);
}

function roomJsonPath(roomId: string): string {
  return join(roomDir(roomId), "room.json");
}

function cursorsPath(roomId: string): string {
  return join(roomDir(roomId), "cursors.json");
}

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    logger.error("room-store", "failed to read directory", { dir, error: String(err) });
    return [];
  }
}

// -- Room CRUD --

export function createRoom(name: string, cwd: string, members: string[], ruleDocs?: string[]): Room {
  ensureRoomsDir();

  const room: Room = {
    id: randomUUID(),
    name,
    cwd,
    members,
    createdAt: Date.now(),
    ...(ruleDocs?.length ? { ruleDocs } : {}),
  };

  const dir = roomDir(room.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(roomJsonPath(room.id), JSON.stringify(room, null, 2), "utf-8");

  // Initialize empty cursors for all members
  const cursors: CursorMap = {};
  for (const m of members) {
    cursors[m] = null;
  }
  writeFileSync(cursorsPath(room.id), JSON.stringify(cursors, null, 2), "utf-8");

  // Initialize empty messages file
  writeFileSync(messagesPath(room.id), "", "utf-8");

  return room;
}

export function getRoom(roomId: string): Room | null {
  const path = roomJsonPath(roomId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Room;
}

export function deleteRoom(roomId: string): boolean {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function updateRoomName(roomId: string, name: string): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  room.name = name;
  writeFileSync(roomJsonPath(roomId), JSON.stringify(room, null, 2), "utf-8");
  return room;
}

/** Update the room's rule document paths (replaces any prior value). */
export function updateRoomRuleDocs(roomId: string, ruleDocs: string[]): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  if (ruleDocs.length > 0) {
    room.ruleDocs = ruleDocs;
  } else {
    delete room.ruleDocs;
  }
  // Legacy field clean-up (0.7.0/0.8.0 migration leftovers)
  delete (room as any).ruleIds;
  delete (room as any).knowledgeBaseId;
  writeFileSync(roomJsonPath(roomId), JSON.stringify(room, null, 2), "utf-8");
  return room;
}

export function listRooms(): Room[] {
  ensureRoomsDir();

  if (!existsSync(ROOMS_DIR)) return [];

  const entries = readDirSafe(ROOMS_DIR);
  const rooms: Room[] = [];

  for (const entry of entries) {
    const path = roomJsonPath(entry);
    if (existsSync(path)) {
      try {
        rooms.push(JSON.parse(readFileSync(path, "utf-8")) as Room);
      } catch (err) {
        logger.error("room-store", "failed to parse room json", { roomId: entry, error: String(err) });
      }
    }
  }

  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return rooms;
}

// -- Cursors --

export function getCursors(roomId: string): CursorMap {
  const path = cursorsPath(roomId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as CursorMap;
}

export function setCursor(roomId: string, agentName: string, cursor: string | null): void {
  const cursors = getCursors(roomId);
  cursors[agentName] = cursor;
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");
}

// -- Member management --

export function addMember(roomId: string, agentName: string): boolean {
  const room = getRoom(roomId);
  if (!room) return false;
  if (room.members.includes(agentName)) return false;

  room.members.push(agentName);
  writeFileSync(roomJsonPath(roomId), JSON.stringify(room, null, 2), "utf-8");

  // Initialize cursor at latest message
  const latestId = getLatestMessageIdInline(roomId);
  const cursors = getCursors(roomId);
  cursors[agentName] = latestId;
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");

  return true;
}

// Inline helper to avoid circular dependency with message-store
function getLatestMessageIdInline(roomId: string): string | null {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null;
  const lines = content.split("\n");
  try {
    const msg = JSON.parse(lines[lines.length - 1]);
    return msg.id;
  } catch (err) {
    logger.error("room-store", "failed to parse last message", { roomId, error: String(err) });
    return null;
  }
}
