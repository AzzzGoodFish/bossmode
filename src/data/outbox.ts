import { canonicalJson, type JsonValue } from "../kernel/json.js";
import { getDatabase, type Database } from "./database.js";

export interface OutboxRecord<T extends JsonValue = JsonValue> {
  id: number;
  kind: string;
  scopeId: string | null;
  dedupeKey: string;
  payload: T;
  createdAt: number;
  attempts: number;
}

interface OutboxRow {
  id: number;
  kind: string;
  scope_id: string | null;
  dedupe_key: string;
  payload_json: string;
  created_at: number;
  attempts: number;
}

function required(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Outbox ${label} is required`);
}

function decode<T extends JsonValue>(row: OutboxRow): OutboxRecord<T> {
  return {
    id: row.id,
    kind: row.kind,
    scopeId: row.scope_id,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as T,
    createdAt: row.created_at,
    attempts: row.attempts,
  };
}

/** Persist one post-commit fact. Repeating an identical key is idempotent;
 * changing any immutable byte under the same key is a conflict. */
export function enqueueOutbox<T extends JsonValue>(
  db: Database,
  input: { kind: string; scopeId?: string | null; dedupeKey: string; payload: T; createdAt?: number },
): void {
  required(input.kind, "kind");
  required(input.dedupeKey, "dedupe key");
  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("Invalid outbox timestamp");
  const payloadJson = canonicalJson(input.payload, "Invalid outbox payload");
  const scopeId = input.scopeId ?? null;
  const old = db.get<OutboxRow>("SELECT * FROM outbox WHERE dedupe_key=?", input.dedupeKey);
  if (old) {
    if (old.kind !== input.kind || old.scope_id !== scopeId || old.payload_json !== payloadJson || old.created_at !== createdAt) {
      throw new Error(`Conflicting outbox identity: ${input.dedupeKey}`);
    }
    return;
  }
  db.run(
    "INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES(?,?,?,?,?)",
    input.kind, scopeId, input.dedupeKey, payloadJson, createdAt,
  );

}

/** Atomically claim a bounded retry batch. A crash leaves it pending; the next
 * claim retries it. The daemon is the sole dispatcher, so attempt increment is
 * the durable claim receipt and no lease table is needed. */
export function claimOutbox<T extends JsonValue = JsonValue>(
  kind: string,
  limit = 500,
  db: Database = getDatabase(),
): OutboxRecord<T>[] {
  required(kind, "kind");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid outbox claim limit");
  return db.transaction(tx => tx.all<OutboxRow>(`UPDATE outbox SET attempts=attempts+1 WHERE id IN
    (SELECT id FROM outbox WHERE kind=? AND delivered_at IS NULL ORDER BY id LIMIT ?) RETURNING *`, kind, limit)
    .sort((a, b) => a.id - b.id).map(row => decode<T>(row)));
}

export function completeOutbox(id: number, completedAt = Date.now(), db: Database = getDatabase()): boolean {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid outbox id");
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) throw new Error("Invalid outbox completion timestamp");
  return Boolean(db.get("UPDATE outbox SET delivered_at=? WHERE id=? AND delivered_at IS NULL RETURNING id", completedAt, id));
}

