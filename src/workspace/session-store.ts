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

export function saveSession(roomId: string, agentName: string, session: AgentSession): void {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sessions = getSessions(roomId);
  sessions[agentName] = session;
  writeFileSync(sessionsPath(roomId), JSON.stringify(sessions, null, 2), "utf-8");
}

export function clearSession(roomId: string, agentName: string, runtime: string): void {
  saveSession(roomId, agentName, { runtime });
}
