import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDatabase, type Database } from "../data/database.js";
import { readConfig } from "../config/settings.js";

export interface SessionToken { token: string; expiresAt: number }
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${createHash("sha256").update(salt + password).digest("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = Buffer.from(createHash("sha256").update(salt + password).digest("hex"), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function importAuthSession(tokenHash: string, expiresAt: number, db: Database = getDatabase()): void {
  if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(expiresAt)) throw new Error("Invalid auth session");
  db.run("INSERT OR REPLACE INTO auth_sessions VALUES (?,?)", tokenHash, expiresAt);
}
export function login(username: string, password: string): SessionToken | null {
  const { auth } = readConfig();
  if (username !== auth.username || !verifyPassword(password, auth.passwordHash)) return null;
  const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + SESSION_TTL_MS;
  importAuthSession(hashAuthToken(token), expiresAt);
  return { token, expiresAt };
}
export function validateToken(token: string): boolean {
  return getDatabase().transaction(db => {
    const hash = hashAuthToken(token), now = Date.now();
    const row = db.get<{ expires_at: number }>("SELECT expires_at FROM auth_sessions WHERE token_hash=?", hash);
    if (!row) return false;
    if (now > row.expires_at) { db.run("DELETE FROM auth_sessions WHERE token_hash=?", hash); return false; }
    if (row.expires_at - now < SESSION_TTL_MS / 2) importAuthSession(hash, now + SESSION_TTL_MS, db);
    return true;
  });
}
export function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}
export function requireAuth(headers: Record<string, string | string[] | undefined>): boolean {
  const token = extractToken(headers);
  return !!token && validateToken(token);
}
export function getSessionExpiresAtForTests(token: string): number | null {
  return getDatabase().get<{ expires_at: number }>("SELECT expires_at FROM auth_sessions WHERE token_hash=?", hashAuthToken(token))?.expires_at ?? null;
}
export function setSessionRemainingForTests(token: string, remainingMs: number): void {
  if (getSessionExpiresAtForTests(token) !== null) importAuthSession(hashAuthToken(token), Date.now() + remainingMs);
}
export function clearSessionsForTests(): void { getDatabase().run("DELETE FROM auth_sessions"); }
