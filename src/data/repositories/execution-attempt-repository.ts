import type { Database } from "../database.js";
import { assertExecutionOwner } from "./execution-identity.js";

export interface ExecutionAttempt {
  id: string; memberId: string; scopeId: string;
  operation: "input" | "session-create" | "session-fork" | "external";
  externalReference: string | null;
  status: "prepared" | "dispatched" | "acknowledged" | "interrupted";
  startedAt: number; dispatchedAt: number | null; endedAt: number | null; diagnosis: string | null;
}
const SELECT = `SELECT id,member_id AS memberId,scope_id AS scopeId,operation,external_reference AS externalReference,
  status,started_at AS startedAt,dispatched_at AS dispatchedAt,ended_at AS endedAt,diagnosis FROM execution_attempts`;
/** Explicit acknowledgement checkpoints, not an SDK history mirror or a replay queue.
 * Commit dispatch BEFORE external IO; acknowledge only after the caller verifies receipt.
 * A restart cannot know whether external IO happened, even for a 'prepared' row. */
export class ExecutionAttemptRepository {
  constructor(private readonly db: Database) {}
  get(id: string, memberId: string): ExecutionAttempt | undefined {
    return this.db.get<ExecutionAttempt>(`${SELECT} WHERE id=? AND member_id=?`, id, memberId);
  }
  prepare(a: Omit<ExecutionAttempt, "status" | "dispatchedAt" | "endedAt" | "diagnosis">): void {
    this.db.run(`INSERT INTO execution_attempts(id,member_id,scope_id,operation,external_reference,status,started_at)
      VALUES(?,?,?,?,?,'prepared',?)`, a.id, a.memberId, assertExecutionOwner(this.db, a.memberId, a.scopeId), a.operation, a.externalReference, a.startedAt);
  }
  markDispatched(id: string, memberId: string, at: number): void {
    if (!this.db.get("UPDATE execution_attempts SET status='dispatched',dispatched_at=? WHERE id=? AND member_id=? AND status='prepared' RETURNING id", at, id, memberId)) {
      throw new Error(`Execution dispatch rejected: ${id}`);
    }
  }
  acknowledge(id: string, memberId: string, at: number): void {
    if (!this.db.get("UPDATE execution_attempts SET status='acknowledged',ended_at=? WHERE id=? AND member_id=? AND status='dispatched' RETURNING id", at, id, memberId)) {
      throw new Error(`Execution acknowledgement rejected: ${id}`);
    }
  }
  /** A failed/cancelled operation is not a successful acknowledgement or safe replay. */
  interrupt(id:string,memberId:string,at:number,diagnosis:string):boolean{
    if(!diagnosis.trim())throw new Error("Execution interruption requires a diagnosis");
    return !!this.db.get("UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis=? WHERE id=? AND member_id=? AND status IN ('prepared','dispatched') RETURNING id",at,diagnosis,id,memberId);
  }
  interruptIncomplete(at: number): number {
    return this.db.transaction(tx => tx.all(`UPDATE execution_attempts SET status='interrupted',ended_at=?,
      diagnosis='completion uncertain after service restart; not replayed' WHERE status IN ('prepared','dispatched') RETURNING id`, at).length);
  }
}
