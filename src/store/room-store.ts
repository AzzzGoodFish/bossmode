import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "./config.js";
import type { Room, RoomMessage, CursorMap } from "../shared/types.js";

const ROOMS_DIR = join(getBossmodeDir(), "rooms");

export function getRoomsDir(): string {
  return ROOMS_DIR;
}

function ensureRoomsDir(): void {
  if (!existsSync(ROOMS_DIR)) {
    mkdirSync(ROOMS_DIR, { recursive: true });
  }
}

function roomDir(roomId: string): string {
  return join(ROOMS_DIR, roomId);
}

function roomJsonPath(roomId: string): string {
  return join(roomDir(roomId), "room.json");
}

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

function cursorsPath(roomId: string): string {
  return join(roomDir(roomId), "cursors.json");
}

// -- Room CRUD --

export function createRoom(name: string, cwd: string, members: string[], knowledgeBaseId?: string, ruleIds?: string[]): Room {
  ensureRoomsDir();

  const room: Room = {
    id: randomUUID(),
    name,
    cwd,
    members,
    createdAt: Date.now(),
    ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
    ...(ruleIds?.length ? { ruleIds } : {}),
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
      } catch {
        // Skip corrupted room files
      }
    }
  }

  // Sort by creation time, newest first
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return rooms;
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// -- Messages --

export function addMessage(roomId: string, msg: Omit<RoomMessage, "id" | "ts">): RoomMessage {
  const message: RoomMessage = {
    id: `msg-${randomUUID().slice(0, 8)}`,
    sender: msg.sender,
    content: msg.content,
    mentions: msg.mentions,
    ts: Date.now(),
  };

  const path = messagesPath(roomId);
  appendFileSync(path, JSON.stringify(message) + "\n", "utf-8");
  return message;
}

export function getMessages(roomId: string, opts?: { limit?: number; before?: string }): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  let messages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  // Filter: messages before a given ID
  if (opts?.before) {
    const idx = messages.findIndex((m) => m.id === opts.before);
    if (idx > 0) {
      messages = messages.slice(0, idx);
    }
  }

  // Limit: return last N messages
  const limit = opts?.limit || 100;
  if (messages.length > limit) {
    messages = messages.slice(-limit);
  }

  return messages;
}

export function getMessagesSince(roomId: string, cursorId: string | null): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  const messages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  if (!cursorId) return messages; // No cursor = all messages

  const idx = messages.findIndex((m) => m.id === cursorId);
  if (idx === -1) return messages; // Cursor not found = all messages
  return messages.slice(idx + 1); // Messages after cursor
}

export function getLatestMessageId(roomId: string): string | null {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null;

  const lines = content.split("\n");
  const lastLine = lines[lines.length - 1];
  try {
    const msg = JSON.parse(lastLine) as RoomMessage;
    return msg.id;
  } catch {
    return null;
  }
}

// -- Cursors --

export function getCursors(roomId: string): CursorMap {
  const path = cursorsPath(roomId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as CursorMap;
}

export function updateCursor(roomId: string, agentName: string, messageId: string): void {
  const cursors = getCursors(roomId);
  cursors[agentName] = messageId;
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
  const latestId = getLatestMessageId(roomId);
  const cursors = getCursors(roomId);
  cursors[agentName] = latestId;
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");

  return true;
}

// -- Archives (F14, F15) --

function archivesDir(roomId: string): string {
  return join(roomDir(roomId), "archives");
}

export interface ArchiveResult {
  archivedCount: number;
  keptCount: number;
  archiveFile: string;
  summaryFile: string;
}

/**
 * Archive old messages, keeping the most recent `keepCount`.
 * Returns archived message data + the timestamp used for file naming.
 */
export function archiveMessages(
  roomId: string,
  keepCount: number = 50,
): { archived: RoomMessage[]; kept: RoomMessage[]; timestamp: number } | null {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null;

  const allMessages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  if (allMessages.length <= keepCount) {
    return null; // Nothing to archive
  }

  const archived = allMessages.slice(0, allMessages.length - keepCount);
  const kept = allMessages.slice(-keepCount);

  // Write archived messages to archive file
  const ts = Date.now();
  const archDir = archivesDir(roomId);
  mkdirSync(archDir, { recursive: true });

  const archiveFile = join(archDir, `${ts}.jsonl`);
  writeFileSync(archiveFile, archived.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  // Overwrite messages file with kept messages only
  writeFileSync(path, kept.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  return { archived, kept, timestamp: ts };
}

/**
 * Save archive summary, using the same timestamp as the archive file.
 */
export function saveArchiveSummary(
  roomId: string,
  summary: string,
  archivedMessages: RoomMessage[],
  timestamp: number,
): void {
  const archDir = archivesDir(roomId);
  mkdirSync(archDir, { recursive: true });

  const summaryData = {
    summary,
    archivedCount: archivedMessages.length,
    range: [
      archivedMessages[0]?.id ?? "",
      archivedMessages[archivedMessages.length - 1]?.id ?? "",
    ],
    ts: timestamp,
  };

  writeFileSync(join(archDir, `${timestamp}.summary.json`), JSON.stringify(summaryData, null, 2), "utf-8");
}

/**
 * List all archives for a room.
 */
export function listArchives(roomId: string): Array<{
  timestamp: number;
  summaryFile: string | null;
  messagesFile: string | null;
}> {
  const archDir = archivesDir(roomId);
  if (!existsSync(archDir)) return [];

  const files = readdirSync(archDir);
  const timestamps = new Set<number>();

  for (const f of files) {
    const match = f.match(/^(\d+)\.(jsonl|summary\.json)$/);
    if (match) timestamps.add(parseInt(match[1], 10));
  }

  return Array.from(timestamps)
    .sort((a, b) => b - a) // newest first
    .map((ts) => ({
      timestamp: ts,
      summaryFile: files.includes(`${ts}.summary.json`) ? join(archDir, `${ts}.summary.json`) : null,
      messagesFile: files.includes(`${ts}.jsonl`) ? join(archDir, `${ts}.jsonl`) : null,
    }));
}

/**
 * Read archived messages from a specific archive file.
 */
export function readArchiveMessages(roomId: string, timestamp: number): RoomMessage[] {
  const filePath = join(archivesDir(roomId), `${timestamp}.jsonl`);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  return content.split("\n").map((line) => JSON.parse(line));
}

/**
 * Read archive summary.
 */
export function readArchiveSummary(roomId: string, timestamp: number): {
  summary: string;
  archivedCount: number;
  range: [string, string];
  ts: number;
} | null {
  const filePath = join(archivesDir(roomId), `${timestamp}.summary.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

// ============================================================================
// Session Management
// ============================================================================

export interface AgentSession {
  runtime: string;
  sessionId?: string;
  sessionFile?: string;
}

function sessionsPath(roomId: string): string {
  return join(roomDir(roomId), "sessions.json");
}

export function getSessions(roomId: string): Record<string, AgentSession> {
  const path = sessionsPath(roomId);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

export function saveSession(roomId: string, agentName: string, session: AgentSession): void {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sessions = getSessions(roomId);
  sessions[agentName] = session;
  writeFileSync(sessionsPath(roomId), JSON.stringify(sessions, null, 2), "utf-8");
}
