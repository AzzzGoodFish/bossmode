import { randomBytes } from "node:crypto";
import { readConfig, verifyPassword } from "../store/config.js";
import type { SessionToken } from "../shared/types.js";

// In-memory session store (single user, single process)
const sessions = new Map<string, { expiresAt: number }>();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function login(username: string, password: string): SessionToken | null {
  const config = readConfig();

  if (username !== config.auth.username) return null;
  if (!verifyPassword(password, config.auth.passwordHash)) return null;

  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt });

  return { token, expiresAt };
}

export function validateToken(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

export function requireAuth(headers: Record<string, string | string[] | undefined>): boolean {
  const token = extractToken(headers);
  if (!token) return false;
  return validateToken(token);
}
