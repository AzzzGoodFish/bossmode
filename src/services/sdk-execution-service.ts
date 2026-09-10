import { randomUUID } from "node:crypto";
import { getDatabase, type Database } from "../storage/database.js";
import { ExecutionAttemptRepository, type ExecutionAttempt } from "../storage/repositories/execution-attempt-repository.js";

/** One actual SDK call, not completion of a parent input, reply, or background task. */
export class SdkExecutionAttempt {
  private uncertainty: string | undefined;
  private interrupted = false;

  constructor(readonly id: string, private readonly memberId: string, private readonly db: Database) {}

  /** Stream callbacks collect evidence without throwing database errors into the SDK emitter. */
  noteUncertain(reason: string): void {
    this.uncertainty ??= `${reason}; SDK completion uncertain; not replayed`;
  }

  /** Targeted, guarded live interruption. Never sweeps other in-flight operations. */
  interrupt(reason: string): void {
    this.noteUncertain(reason);
    if (this.interrupted) return;
    this.db.assertOutsideTransaction();
    if (!this.db.get(`UPDATE execution_attempts SET status='interrupted',ended_at=?,diagnosis=?
      WHERE id=? AND member_id=? AND status IN ('prepared','dispatched') RETURNING id`,
    Date.now(), this.uncertainty, this.id, this.memberId)) {
      throw new Error(`SDK execution interruption rejected: ${this.id}`);
    }
    this.interrupted = true;
  }

  /** Resolution alone is insufficient when the SDK streamed a provider error or abort. */
  settle(): void {
    this.db.assertOutsideTransaction();
    if (this.uncertainty) this.interrupt(this.uncertainty);
    else new ExecutionAttemptRepository(this.db).acknowledge(this.id, this.memberId, Date.now());
  }

  fail(error: unknown): never {
    try { this.interrupt(`SDK call failed: ${error instanceof Error ? error.message : String(error)}`); }
    catch (recordError) { throw new AggregateError([error, recordError], "SDK call and execution recording failed"); }
    throw error;
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      this.settle();
      return result;
    } catch (error) { return this.fail(error); }
  }
}

/** Short SQL dispatch transaction commits before any SDK/resource IO. No implicit DB or owner fallback. */
export class SdkExecutionService {
  constructor(private readonly memberId: string, private readonly scopeId: string, private readonly db = getDatabase()) {}

  dispatch(operation: ExecutionAttempt["operation"], externalReference: string, beforeDispatch?: (attemptId: string) => void): SdkExecutionAttempt {
    this.db.assertOutsideTransaction();
    // Reject native async hooks before even their synchronous prefix can run.
    if (beforeDispatch?.constructor.name === "AsyncFunction") throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
    const id = randomUUID();
    this.db.transaction(tx => {
      const repo = new ExecutionAttemptRepository(tx);
      repo.prepare({ id, memberId: this.memberId, scopeId: this.scopeId, operation, externalReference, startedAt: Date.now() });
      repo.markDispatched(id, this.memberId, Date.now());
      const result: unknown = beforeDispatch?.(id);
      if (result != null && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
      }
    });
    return new SdkExecutionAttempt(id, this.memberId, this.db);
  }
}
