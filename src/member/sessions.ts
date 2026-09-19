import { memberDir, getBossmodeDir } from "../files/layout.js";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
export interface AgentSession { runtime: string; sessionId?: string; sessionFile?: string }
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

/** The member's one session across every chat (① A1: key is the member alone). */
export function getCurrentSession(memberId: string): AgentSession | undefined {
  validateMemberId(memberId);
  const association = readSessionAssociation(memberId, getDatabase());
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
    const previous = readSessionAssociation(memberId, getDatabase());
    if (previous?.referenceKind === "legacy-absolute" && previous.session.sessionFile === sessionValue.sessionFile) {
      getCurrentSession(memberId); // Revalidate the imported file before keeping its reference.
      session.sessionFile = sessionValue.sessionFile;
      referenceKind = "legacy-absolute";
    } else session.sessionFile = archiveRelativePath(memberId, sessionValue.sessionFile);
  }
  const now = Date.now();
  importSessionAssociation({memberId, session, referenceKind, createdAt: now, updatedAt: now}, getDatabase());
}

export function clearCurrentSession(memberId: string): void {
  validateMemberId(memberId);
  deleteSessionAssociation(memberId, getDatabase());
}

/** One session row per member (① A1): the member key alone identifies it. */
export interface SessionAssociation {
  memberId: string;
  session: AgentSession;
  referenceKind: "member-relative" | "legacy-absolute";
  createdAt: number;
  updatedAt: number;
}

interface Row {
  member_id: string; runtime: string; sdk_session_id: string | null;
  file_reference: string | null; reference_kind: SessionAssociation["referenceKind"]; created_at: number; updated_at: number;
}

export function readSessionAssociation(memberId: string, db: Database = getDatabase()): SessionAssociation | undefined {
    const r = db.get<Row>("SELECT * FROM current_sessions WHERE member_id=?", memberId);
    if (!r) return;
    return { memberId: r.member_id, session: { runtime: r.runtime,
      ...(r.sdk_session_id === null ? {} : {sessionId: r.sdk_session_id}),
      ...(r.file_reference === null ? {} : {sessionFile: r.file_reference}) },
    referenceKind: r.reference_kind, createdAt: r.created_at, updatedAt: r.updated_at };
  }

export function importSessionAssociation(a: SessionAssociation, db: Database = getDatabase()): void {
    validateMemberId(a.memberId);
    if (!db.get("SELECT id FROM members WHERE id=?",a.memberId)) throw new Error(`Unknown execution member ID: ${a.memberId}`);
    const file = a.session.sessionFile;
    if (!a.session.runtime || typeof a.session.runtime !== "string") throw new Error("Invalid session runtime");
    if (a.session.sessionId !== undefined && typeof a.session.sessionId !== "string") throw new Error("Invalid SDK session ID");
    if (file !== undefined && (typeof file !== "string" || !file || file.includes("\0") ||
      (a.referenceKind === "member-relative" ? isAbsolute(file) || file.split(/[/\\]/).includes("..") : !isAbsolute(file)))) {
      throw new Error("Invalid session file reference");
    }
    if (file !== undefined && a.referenceKind === "member-relative") {
      if (!MEMBER_SESSION_PATTERN.test(file)) {
        throw new Error("Session file reference does not match the member session archive");
      }
    }
    db.run(`INSERT INTO current_sessions(member_id,runtime,sdk_session_id,file_reference,reference_kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET runtime=excluded.runtime,
      sdk_session_id=excluded.sdk_session_id, file_reference=excluded.file_reference, reference_kind=excluded.reference_kind,
      updated_at=excluded.updated_at`, a.memberId, a.session.runtime, a.session.sessionId ?? null,
    file ?? null, a.referenceKind, a.createdAt, a.updatedAt);
  }

export function deleteSessionAssociation(memberId: string, db: Database = getDatabase()): void {
    db.run("DELETE FROM current_sessions WHERE member_id=?", memberId);
  }
