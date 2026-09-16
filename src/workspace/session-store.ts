import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { memberDir } from "./member-profile.js";
import { getBossmodeDir } from "../shared/config.js";
import { getDatabase } from "../data/database.js";
import { SessionRepository } from "../data/repositories/session-repository.js";
import type { AgentSession } from "../kernel/types.js";

function repository(): SessionRepository { return new SessionRepository(getDatabase()); }
const SAFE_ID = /^[^/:\\]+$/;
/** Member session files live under `sessions/<day>/main/` (① A2). */
const MEMBER_SESSION_PATTERN = /^sessions\/\d{4}-\d{2}-\d{2}\/main\/[^/]+\.jsonl$/;

function validateMemberId(memberId: string): void {
  if (!SAFE_ID.test(memberId) || memberId === "." || memberId === "..") throw new Error(`Invalid member ID: ${memberId}`);
}
function validateSession(memberId: string, value: unknown): AgentSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid session entry for member ${memberId}`);
  const session = value as AgentSession;
  if (typeof session.runtime !== "string" || !session.runtime) throw new Error(`Invalid runtime for member ${memberId}`);
  if (session.sessionId !== undefined && typeof session.sessionId !== "string") throw new Error(`Invalid sessionId for member ${memberId}`);
  if (session.sessionFile !== undefined && (typeof session.sessionFile !== "string" || isAbsolute(session.sessionFile))) {
    throw new Error(`Invalid relative sessionFile for member ${memberId}`);
  }
  return session;
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
function archiveRelativePath(memberId: string, file: string): string {
  const root = realpathSync(memberDir(memberId));
  const absolute = resolve(file);
  const rel = relative(root, absolute).split(sep).join("/");
  if (!MEMBER_SESSION_PATTERN.test(rel)) throw new Error(`Session file is outside the member session store: ${file}`);
  const realParent = existingRealPath(dirname(absolute));
  if (realParent !== root && !realParent.startsWith(root + sep)) throw new Error(`Session archive path escapes member directory: ${file}`);
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`Session file may not be a symlink: ${file}`);
    if (!lstatSync(absolute).isFile()) throw new Error(`Session reference is not a file: ${file}`);
    const realFile = realpathSync(absolute);
    if (!realFile.startsWith(root + sep)) throw new Error(`Session file escapes member directory: ${file}`);
  }
  return rel;
}

export { mainSessionDirectory } from "./member-session-paths.js";

/** The member's one session across every chat (① A1: key is the member alone). */
export function getCurrentSession(memberId: string): AgentSession | undefined {
  validateMemberId(memberId);
  const association = repository().get(memberId);
  const session = association?.session;
  if (!session?.sessionFile) return session;
  const absolute = association!.referenceKind === "legacy-absolute"
    ? session.sessionFile : resolve(memberDir(memberId), session.sessionFile);
  if (association!.referenceKind === "legacy-absolute") {
    // Imported references retain their exact SDK location. Ownership came from
    // verified import metadata, never the basename or today's member name.
    const root = realpathSync(getBossmodeDir());
    if (!existsSync(absolute)) throw new Error(`Session file referenced by database is missing: ${absolute}`);
    if (!lstatSync(absolute).isFile() || !realpathSync(absolute).startsWith(root + sep)) {
      throw new Error(`Legacy session reference escapes data root: ${absolute}`);
    }
  } else archiveRelativePath(memberId, absolute);
  if (!existsSync(absolute)) throw new Error(`Session file referenced by database is missing: ${absolute}`);
  return { ...session, sessionFile: absolute };
}

export function saveCurrentSession(memberId: string, sessionValue: AgentSession): void {
  validateMemberId(memberId);
  const session = { ...validateSession(memberId, { ...sessionValue, sessionFile: undefined }) };
  let referenceKind: "member-relative" | "legacy-absolute" = "member-relative";
  if (sessionValue.sessionFile) {
    const previous = repository().get(memberId);
    if (previous?.referenceKind === "legacy-absolute" && previous.session.sessionFile === sessionValue.sessionFile) {
      getCurrentSession(memberId); // Revalidate the imported file before keeping its reference.
      session.sessionFile = sessionValue.sessionFile;
      referenceKind = "legacy-absolute";
    } else session.sessionFile = archiveRelativePath(memberId, sessionValue.sessionFile);
  }
  const now = Date.now();
  repository().importAssociation({memberId, session, referenceKind, createdAt: now, updatedAt: now});
}

export function clearCurrentSession(memberId: string): void {
  validateMemberId(memberId);
  repository().clear(memberId);
}
