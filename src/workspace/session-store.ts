import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { memberDir } from "./member-profile.js";
import type { AgentSession } from "../shared/types.js";

export type MainScopeId = `room:${string}` | `dm:${string}` | `topic:${string}`;
type CurrentSessions = Record<MainScopeId, AgentSession>;
const SAFE_ID = /^[^/:\\]+$/;

function canonicalScope(scope: string, memberId: string): MainScopeId {
  if (!scope.includes(":")) {
    if (!SAFE_ID.test(scope)) throw new Error(`Invalid member session scope: ${scope}`);
    return `room:${scope}`;
  }
  const split = scope.indexOf(":");
  const kind = scope.slice(0, split);
  const id = scope.slice(split + 1);
  if (!SAFE_ID.test(id) || !["room", "topic", "dm"].includes(kind)) throw new Error(`Invalid member session scope: ${scope}`);
  if (kind === "dm" && id !== memberId) throw new Error(`DM session scope does not belong to member ${memberId}`);
  return scope as MainScopeId;
}
function currentPath(memberId: string): string { return join(memberDir(memberId), "sessions", "current.json"); }
function validateSession(scope: MainScopeId, value: unknown): AgentSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid session entry for ${scope}`);
  const session = value as AgentSession;
  if (typeof session.runtime !== "string" || !session.runtime) throw new Error(`Invalid runtime for ${scope}`);
  if (session.sessionId !== undefined && typeof session.sessionId !== "string") throw new Error(`Invalid sessionId for ${scope}`);
  if (session.sessionFile !== undefined && (typeof session.sessionFile !== "string" || isAbsolute(session.sessionFile))) {
    throw new Error(`Invalid relative sessionFile for ${scope}`);
  }
  return session;
}
function readCurrent(memberId: string): CurrentSessions {
  const path = currentPath(memberId);
  if (!existsSync(path)) return {} as CurrentSessions;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    const result = {} as CurrentSessions;
    for (const [key, session] of Object.entries(value)) {
      const scope = canonicalScope(key, memberId);
      result[scope] = validateSession(scope, session);
    }
    return result;
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
function scopePathPattern(scope: MainScopeId): RegExp {
  const escaped = scope.slice(scope.indexOf(":") + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = scope.startsWith("room:") ? `rooms/${escaped}` : scope.startsWith("topic:") ? `topics/${escaped}` : "dm";
  return new RegExp(`^sessions/\\d{4}-\\d{2}-\\d{2}/${tail}/[^/]+\\.jsonl$`);
}
function existingRealPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing parent for session path: ${path}`);
    current = parent;
  }
  return realpathSync(current);
}
function archiveRelativePath(memberId: string, scope: MainScopeId, file: string): string {
  const root = realpathSync(memberDir(memberId));
  const absolute = resolve(file);
  const rel = relative(root, absolute).split(sep).join("/");
  if (!scopePathPattern(scope).test(rel)) throw new Error(`Session file is outside the ${scope} archive: ${file}`);
  const realParent = existingRealPath(dirname(absolute));
  if (realParent !== root && !realParent.startsWith(root + sep)) throw new Error(`Session archive path escapes member directory: ${file}`);
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`Session file may not be a symlink: ${file}`);
    const realFile = realpathSync(absolute);
    if (!realFile.startsWith(root + sep)) throw new Error(`Session file escapes member directory: ${file}`);
  }
  return rel;
}

export { mainSessionDirectory } from "./member-session-paths.js";
export function getCurrentSession(memberId: string, scopeValue: string): AgentSession | undefined {
  const scope = canonicalScope(scopeValue, memberId);
  const session = readCurrent(memberId)[scope];
  if (!session?.sessionFile) return session;
  const absolute = resolve(memberDir(memberId), session.sessionFile);
  archiveRelativePath(memberId, scope, absolute);
  if (!existsSync(absolute)) throw new Error(`Session file referenced by current.json is missing: ${absolute}`);
  return { ...session, sessionFile: absolute };
}
export function saveCurrentSession(memberId: string, scopeValue: string, sessionValue: AgentSession): void {
  const scope = canonicalScope(scopeValue, memberId);
  const session = { ...validateSession(scope, { ...sessionValue, sessionFile: undefined }) };
  if (sessionValue.sessionFile) session.sessionFile = archiveRelativePath(memberId, scope, sessionValue.sessionFile);
  const all = readCurrent(memberId);
  all[scope] = session;
  writeCurrent(memberId, all);
}
export function clearCurrentSession(memberId: string, scopeValue: string): void {
  const scope = canonicalScope(scopeValue, memberId);
  const all = readCurrent(memberId);
  if (!(scope in all)) return;
  delete all[scope];
  writeCurrent(memberId, all);
}
export const deleteCurrentSession = clearCurrentSession;
export function getSessions(scope: string, memberId: string): Record<string, AgentSession> {
  const session = getCurrentSession(memberId, scope);
  return session ? { [memberId]: session } : {};
}
export function saveSession(scope: string, memberId: string, session: AgentSession): void { saveCurrentSession(memberId, scope, session); }
export function clearSession(scope: string, memberId: string, _runtime: string): void { clearCurrentSession(memberId, scope); }
export function deleteSessionEntry(scope: string, memberId: string): void { clearCurrentSession(memberId, scope); }
