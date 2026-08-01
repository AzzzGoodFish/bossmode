import { randomBytes } from "node:crypto";
import { readConfig, verifyPassword } from "../shared/config.js";
import type { SessionToken } from "../shared/types.js";

// In-memory session store (single user, single process)
const sessions = new Map<string, { expiresAt: number }>();

/** Full idle TTL. Sliding renewal extends back to this on active use. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function login(username: string, password: string): SessionToken | null {
  const config = readConfig();

  if (username !== config.auth.username) return null;
  if (!verifyPassword(password, config.auth.passwordHash)) return null;

  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt });

  return { token, expiresAt };
}

/**
 * Validate session token. On success, if less than half the TTL remains,
 * slide expiry forward to a fresh 24h window (active users never drop offline;
 * idle 24h still expires). Single-user / single-process safety surface unchanged.
 */
export function validateToken(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  const now = Date.now();
  if (now > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  // Sliding renewal: remaining < half TTL → extend to full TTL from now.
  const remaining = session.expiresAt - now;
  if (remaining < SESSION_TTL_MS / 2) {
    session.expiresAt = now + SESSION_TTL_MS;
  }
  return true;
}

/** Test helper: peek session expiry (ms epoch) or null. */
export function getSessionExpiresAtForTests(token: string): number | null {
  return sessions.get(token)?.expiresAt ?? null;
}

/** Test helper: force a session's remaining TTL (ms from now). */
export function setSessionRemainingForTests(token: string, remainingMs: number): void {
  const session = sessions.get(token);
  if (!session) return;
  session.expiresAt = Date.now() + remainingMs;
}

/** Test helper: clear all sessions. */
export function clearSessionsForTests(): void {
  sessions.clear();
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
