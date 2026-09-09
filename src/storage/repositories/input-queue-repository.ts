import type { Database } from "../database.js";
import { DeliveryRepository, deliveryJson, deliveryKeyParams, deliveryText, deliveryTime, type DeliveryJson, type DeliveryKey } from "./delivery-repository.js";

export type QueuedInputStatus = "pending" | "dispatched" | "settled" | "interrupted" | "uncertain";
export interface QueuedInput extends DeliveryKey {
  id: number;
  payload: DeliveryJson;
  trigger: string;
  status: QueuedInputStatus;
  createdAt: number;
  dispatchedAt: number | null;
  endedAt: number | null;
  dispatchToken: string | null;
  /** Optional correlation only. Parent owns D prepare/dispatch/acknowledge in
   * the SAME SQL transaction; this repository does not create SDK attempts. */
  executionAttemptId: string | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  result: DeliveryJson;
  diagnosis: string | null;
}
export interface QueuedInputOwner { id: number; scopeId: string; targetActorKey: string }
type Row = Omit<QueuedInput, "payload" | "result"> & { payloadJson: string; resultJson: string | null };
const SELECT = `SELECT id,scope_id AS scopeId,message_id AS messageId,target_actor_key AS targetActorKey,
  delivery_kind AS deliveryKind,payload_json AS payloadJson,trigger,status,created_at AS createdAt,
  dispatched_at AS dispatchedAt,ended_at AS endedAt,dispatch_token AS dispatchToken,
  execution_attempt_id AS executionAttemptId,outcome,result_json AS resultJson,diagnosis FROM queued_inputs`;
function decode(row: Row): QueuedInput {
  const { payloadJson, resultJson, ...fields } = row;
  return { ...fields, payload: JSON.parse(payloadJson), result: resultJson === null ? null : JSON.parse(resultJson) };
}
function ownerParams(owner: QueuedInputOwner): [number, string, string] {
  if (!Number.isSafeInteger(owner.id) || owner.id < 1) throw new Error("Invalid queued input ID");
  deliveryText(owner.scopeId, "scope ID");
  deliveryText(owner.targetActorKey, "target actor key");
  return [owner.id, owner.scopeId, owner.targetActorKey];
}

/** Durable payload/state only. Never invokes closures, providers, tools or SDKs.
 * pending is safe only when parent commits beginDispatch BEFORE any external work.
 * Terminal records cannot be reset to pending; unknown dispatch is never replayed. */
export class InputQueueRepository {
  constructor(private readonly db: Database) {}

  get(owner: QueuedInputOwner): QueuedInput | undefined {
    const row = this.db.get<Row>(`${SELECT} WHERE id=? AND scope_id=? AND target_actor_key=?`, ...ownerParams(owner));
    return row && decode(row);
  }

  enqueue(input: DeliveryKey & { payload: DeliveryJson; trigger: string }, at: number): { enqueued: boolean; input: QueuedInput } {
    deliveryTime(at);
    deliveryText(input.trigger, "input trigger");
    const key = deliveryKeyParams(input);
    const payload = deliveryJson(input.payload);
    return this.db.transaction(tx => {
      if (!new DeliveryRepository(tx).getDelivery(input)) throw new Error("Queued input requires captured delivery acceptance");
      const old = tx.get<Row>(`${SELECT} WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`, ...key);
      if (old) {
        if (old.payloadJson !== payload || old.trigger !== input.trigger) throw new Error("Conflicting queued input identity");
        return { enqueued: false, input: decode(old) };
      }
      const row = tx.get<{id: number}>(`INSERT INTO queued_inputs(scope_id,message_id,target_actor_key,delivery_kind,payload_json,trigger,status,created_at)
        VALUES(?,?,?,?,?,?,'pending',?) RETURNING id`, ...key, payload, input.trigger, at)!;
      return { enqueued: true, input: new InputQueueRepository(tx).get({ id: row.id, scopeId: input.scopeId, targetActorKey: input.targetActorKey })! };
    });
  }

  /** Indexed keyset listing. Omitting actor lists all safe pending inputs; no dispatch. */
  listPending(options: { actor?: { scopeId: string; targetActorKey: string }; afterId?: number; limit?: number } = {}): QueuedInput[] {
    const { afterId = 0, limit = 100, actor } = options;
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid queued input page");
    const where = actor ? " AND scope_id=? AND target_actor_key=?" : "";
    return this.db.all<Row>(`${SELECT} WHERE status='pending' AND id>?${where} ORDER BY id LIMIT ?`,
      afterId, ...(actor ? [actor.scopeId, actor.targetActorKey] : []), limit).map(decode);
  }

  /** One winner can dispatch. false means absent/wrong owner/not pending. The
   * caller must check it, and wait for OUTER COMMIT before invoking external IO. */
  beginDispatch(owner: QueuedInputOwner, dispatch: { token: string; executionAttemptId: string | null }, at: number): boolean {
    deliveryTime(at);
    deliveryText(dispatch.token, "dispatch token");
    if (dispatch.executionAttemptId !== null) deliveryText(dispatch.executionAttemptId, "execution attempt ID");
    return !!this.db.get(`UPDATE queued_inputs SET status='dispatched',dispatched_at=?,dispatch_token=?,execution_attempt_id=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status='pending' RETURNING id`,
    at, dispatch.token, dispatch.executionAttemptId, ...ownerParams(owner));
  }

  /** Only a verified SDK/provider settlement belongs here, not routing callback
   * acceptance. This does not settle chat obligations or imply tool side effects
   * were atomic. The token guards stale/other-dispatch callbacks. */
  settle(owner: QueuedInputOwner, token: string, result: { outcome: "completed" | "failed" | "cancelled"; result: DeliveryJson }, at: number): boolean {
    deliveryTime(at);
    deliveryText(token, "dispatch token");
    if (!["completed", "failed", "cancelled"].includes(result.outcome)) throw new Error("Invalid queued input outcome");
    const json = deliveryJson(result.result);
    return !!this.db.get(`UPDATE queued_inputs SET status='settled',ended_at=?,outcome=?,result_json=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status='dispatched' AND dispatch_token=? RETURNING id`,
    at, result.outcome, json, ...ownerParams(owner), token);
  }

  /** Cancelling pending work proves it never dispatched. Interrupting dispatched
   * work only records uncertainty, never a successful SDK cancellation. */
  interrupt(owner: QueuedInputOwner, expected: { status: "pending" } | { status: "dispatched"; token: string }, diagnosis: string, at: number): boolean {
    deliveryTime(at);
    deliveryText(diagnosis, "interruption diagnosis");
    if (expected.status !== "pending" && expected.status !== "dispatched") throw new Error("Invalid interruption source state");
    if (expected.status === "dispatched") deliveryText(expected.token, "dispatch token");
    return !!this.db.get(`UPDATE queued_inputs SET status=?,ended_at=?,diagnosis=?
      WHERE id=? AND scope_id=? AND target_actor_key=? AND status=?${expected.status === "dispatched" ? " AND dispatch_token=?" : ""} RETURNING id`,
    expected.status === "pending" ? "interrupted" : "uncertain", at, diagnosis, ...ownerParams(owner), expected.status,
    ...(expected.status === "dispatched" ? [expected.token] : []));
  }

  /** Explicit startup-only sweep after runtime quiescence. Safe pending payloads
   * survive unchanged; no callbacks, queue reconstruction or automatic replay. */
  recoverStartup(at: number): { uncertain: number } {
    deliveryTime(at);
    return this.db.transaction(tx => ({ uncertain: tx.all(`UPDATE queued_inputs SET status='uncertain',ended_at=?,
      diagnosis='dispatch outcome uncertain after service restart; not replayed'
      WHERE status='dispatched' RETURNING id`, at).length }));
  }
}
