import { isAbsolute } from "node:path";
import type { AgentSession } from "../../shared/types.js";
import type { Database } from "../database.js";
import { assertExecutionMember } from "./execution-identity.js";

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

export class SessionRepository {
  constructor(private readonly db: Database) {}
  get(memberId: string): SessionAssociation | undefined {
    const r = this.db.get<Row>("SELECT * FROM current_sessions WHERE member_id=?", memberId);
    if (!r) return;
    return { memberId: r.member_id, session: { runtime: r.runtime,
      ...(r.sdk_session_id === null ? {} : {sessionId: r.sdk_session_id}),
      ...(r.file_reference === null ? {} : {sessionFile: r.file_reference}) },
    referenceKind: r.reference_kind, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  /** Pure import/upsert: no file access, SDK call, implicit clock, or identity inference.
   * Parent verifies source ownership and file containment before calling. */
  importAssociation(a: SessionAssociation): void {
    assertExecutionMember(this.db, a.memberId);
    const file = a.session.sessionFile;
    if (!a.session.runtime || typeof a.session.runtime !== "string") throw new Error("Invalid session runtime");
    if (a.session.sessionId !== undefined && typeof a.session.sessionId !== "string") throw new Error("Invalid SDK session ID");
    if (file !== undefined && (typeof file !== "string" || !file || file.includes("\0") ||
      (a.referenceKind === "member-relative" ? isAbsolute(file) || file.split(/[/\\]/).includes("..") : !isAbsolute(file)))) {
      throw new Error("Invalid session file reference");
    }
    if (file !== undefined && a.referenceKind === "member-relative") {
      const parts = file.split("/");
      if (parts.length !== 4 || parts[0] !== "sessions" || !/^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? "") ||
        parts[2] !== "main" || !/^[^/]+\.jsonl$/.test(parts[3] ?? "")) {
        throw new Error("Session file reference does not match the member session archive");
      }
    }
    this.db.run(`INSERT INTO current_sessions(member_id,runtime,sdk_session_id,file_reference,reference_kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET runtime=excluded.runtime,
      sdk_session_id=excluded.sdk_session_id, file_reference=excluded.file_reference, reference_kind=excluded.reference_kind,
      updated_at=excluded.updated_at`, a.memberId, a.session.runtime, a.session.sessionId ?? null,
    file ?? null, a.referenceKind, a.createdAt, a.updatedAt);
  }
  clear(memberId: string): void {
    this.db.run("DELETE FROM current_sessions WHERE member_id=?", memberId);
  }
}
