import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readConfig } from "../config/config.js";
import type { SessionToken } from "../kernel/types.js";

import { getDatabase } from "../data/database.js";
import { AuthSessionsRepository } from "../data/repositories/settings.js";
function sessions(): AuthSessionsRepository { return new AuthSessionsRepository(getDatabase()); }

// Password hashing: SHA-256 with salt (moved out of config in P9 — auth concern)
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHash] = stored.split(":");
  if (!salt || !expectedHash) return false;
  const hash = createHash("sha256").update(salt + password).digest("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


/** Full idle TTL. Sliding renewal extends back to this on active use. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function login(username: string, password: string): SessionToken | null {
  const config = readConfig();

  if (username !== config.auth.username) return null;
  if (!verifyPassword(password, config.auth.passwordHash)) return null;

  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions().set(token, expiresAt);

  return { token, expiresAt };
}

/**
 * Validate session token. On success, if less than half the TTL remains,
 * slide expiry forward to a fresh 24h window (active users never drop offline;
 * idle 24h still expires). Single-user / single-process safety surface unchanged.
 */
export function validateToken(token: string): boolean {
  return sessions().validate(token, Date.now(), SESSION_TTL_MS);
}

/** Test helper: peek session expiry (ms epoch) or null. */
export function getSessionExpiresAtForTests(token: string): number | null {
  return sessions().expiresAt(token);
}

/** Test helper: force a session's remaining TTL (ms from now). */
export function setSessionRemainingForTests(token: string, remainingMs: number): void {
  if (sessions().expiresAt(token) === null) return;
  sessions().set(token, Date.now() + remainingMs);
}

/** Test helper: clear all sessions. */
export function clearSessionsForTests(): void {
  sessions().clear();
}
