import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { memberDir } from "./member-profile.js";
import { mainSessionDirectory } from "./member-session-paths.js";
import type { AgentSession } from "../shared/types.js";

export type MainScopeId = `room:${string}` | `dm:${string}` | `topic:${string}`;
type CurrentSessions = Record<string, AgentSession>;

function scopeId(scope: string, memberId: string): MainScopeId {
  if (/^room:[^/]+$/.test(scope) || /^topic:[^/]+$/.test(scope)) return scope as MainScopeId;
  if (scope === `dm:${memberId}`) return scope as MainScopeId;
  if (!scope.includes(":")) return `room:${scope}`;
  throw new Error(`Invalid member session scope: ${scope}`);
}

function currentPath(memberId: string): string {
  return join(memberDir(memberId), "sessions", "current.json");
}

function readCurrent(memberId: string): CurrentSessions {
  const path = currentPath(memberId);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new Error(`Invalid member session current.json for ${memberId}: ${String(error)}`);
  }
}

function writeCurrent(memberId: string, sessions: CurrentSessions): void {
  const path = currentPath(memberId);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(sessions, null, 2) + "\n", "utf-8");
  renameSync(temp, path);
}

export { mainSessionDirectory } from "./member-session-paths.js";

/** Returns the member's one authoritative current reference for this scope. */
export function getCurrentSession(memberId: string, scope: string): AgentSession | undefined {
  const session = readCurrent(memberId)[scopeId(scope, memberId)];
  if (!session?.sessionFile) return session;
  const root = resolve(memberDir(memberId));
  const absolute = resolve(root, session.sessionFile);
  if (!absolute.startsWith(root + "/")) throw new Error(`Invalid session path in current.json for ${memberId}`);
  return { ...session, sessionFile: absolute };
}

/** Atomically commits a reference only after the SDK has created/opened its session. */
export function saveCurrentSession(memberId: string, scope: string, session: AgentSession): void {
  const root = resolve(memberDir(memberId));
  const id = scopeId(scope, memberId);
  const file = session.sessionFile ? resolve(session.sessionFile) : undefined;
  if (file && !file.startsWith(root + "/")) throw new Error(`Session file must be inside member archive: ${file}`);
  const all = readCurrent(memberId);
  all[id] = { ...session, sessionFile: file ? relative(root, file) : undefined };
  writeCurrent(memberId, all);
}

/** Reset/delete only removes the reference. The SDK JSONL is deliberately retained. */
export function clearCurrentSession(memberId: string, scope: string): void {
  const all = readCurrent(memberId);
  const id = scopeId(scope, memberId);
  if (!(id in all)) return;
  delete all[id];
  writeCurrent(memberId, all);
}

/** Remove a scope reference when its room/topic goes away; history stays in member storage. */
export const deleteCurrentSession = clearCurrentSession;

/**
 * Compatibility-shaped API used by agent-manager while storage is now member-owned.
 * `scope` may be a raw room id only for callers that already provide `memberId`.
 */
export function getSessions(scope: string, memberId: string): Record<string, AgentSession> {
  const session = getCurrentSession(memberId, scope);
  return session ? { [memberId]: session } : {};
}

export function saveSession(scope: string, memberId: string, session: AgentSession): void {
  saveCurrentSession(memberId, scope, session);
}

export function clearSession(scope: string, memberId: string, _runtime: string): void {
  clearCurrentSession(memberId, scope);
}

export function deleteSessionEntry(scope: string, memberId: string): void {
  clearCurrentSession(memberId, scope);
}

/** Relative archive pathname for safe display/search results. */
export function sessionPathRelativeToMember(memberId: string, file: string): string | null {
  const root = resolve(memberDir(memberId));
  const candidate = resolve(file);
  const rel = relative(root, candidate);
  return rel && !rel.startsWith("..") && !resolve(root, rel).startsWith(root + "/../") ? rel : null;
}
