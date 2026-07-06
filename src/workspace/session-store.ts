import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { roomDir } from "./room-store.js";
import type { AgentSession } from "../shared/types.js";

function sessionsPath(roomId: string): string {
  return join(roomDir(roomId), "sessions.json");
}

export function getSessions(roomId: string): Record<string, AgentSession> {
  const path = sessionsPath(roomId);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

export function saveSession(roomId: string, memberId: string, session: AgentSession): void {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sessions = getSessions(roomId);
  sessions[memberId] = session;
  writeFileSync(sessionsPath(roomId), JSON.stringify(sessions, null, 2), "utf-8");
}

export function clearSession(roomId: string, memberId: string, runtime: string): void {
  saveSession(roomId, memberId, { runtime });
}

export function deleteSessionEntry(roomId: string, memberId: string): void {
  const path = sessionsPath(roomId);
  const sessions = getSessions(roomId);
  if (sessions[memberId] === undefined) return;
  delete sessions[memberId];
  writeFileSync(path, JSON.stringify(sessions, null, 2), "utf-8");
}
